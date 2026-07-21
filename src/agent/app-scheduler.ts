import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { runSchedule } from "./runner";
import type { ResolvePrebuilt } from "./runner";
import type { AppHost } from "./app-host";
import type { AppFile } from "../templates/types";
import type { Env, ScheduledTaskInfo } from "../types";

/**
 * AppScheduler — the per-room task scheduler (broker.requestScheduler).
 *
 * A Durable Object keyed by the app instance (room id), with its OWN SQLite and a
 * single Durable Object ALARM. An app schedules work through the `ScopedScheduler`
 * capability; when a task comes due this DO's `alarm()` runs the app's optional
 * `onSchedule(env, ctx)` export in the sandbox (via `runner.runSchedule`) — the
 * SAME isolation as every other app run: only `env.SYSTEM`, no raw bindings. The
 * task can therefore do anything the app can (store, fetch, email, and crucially
 * push to connected clients via `requestRoom`).
 *
 * WHY A DEDICATED DO (limitation #3): scheduling state + the alarm live off
 * AppHost, so timer churn never contends with the code/version store or the
 * realtime coordinator's input gate. The stub reaches this DO DIRECTLY by name
 * (`env.APP_SCHEDULER.idFromName(instance)`), exactly like AppData.
 *
 * WHY AN ALARM (not setTimeout): a plain timer is lost if the DO hibernates; a
 * DO alarm survives hibernation and re-fires on wake. One alarm is armed to the
 * EARLIEST pending task; `alarm()` processes everything due, reschedules
 * recurring tasks, drops one-shots, then re-arms to the next earliest.
 */

/** Floor for one-shot delays and recurring intervals — guards against alarm storms. */
const MIN_DELAY_MS = 1_000;
/** Max tasks processed in a single alarm pass (the rest wait for the re-arm). */
const BATCH = 100;

type TaskRow = {
  id: string;
  task: string;
  payload: string | null;
  run_at: number;
  interval_ms: number | null;
  created_at: number;
};

export class AppScheduler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS scheduled (id TEXT PRIMARY KEY, task TEXT NOT NULL, payload TEXT, run_at INTEGER NOT NULL, interval_ms INTEGER, created_at INTEGER NOT NULL)"
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sched_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
    );
  }

  // ── scheduling API (invoked by ScopedScheduler over RPC) ──

  /**
   * Insert a task and (re)arm the alarm to the earliest pending run time. The DO
   * input gate makes the count-check + insert atomic, so concurrent schedules
   * can't both slip past `maxTasks`. `runAt` is a ms epoch; `intervalMs` set =>
   * recurring. Both are floored to MIN_DELAY_MS by the caller.
   */
  async scheduleTask(req: {
    instance: string;
    task: string;
    payload: string | null;
    runAt: number;
    intervalMs: number | null;
    maxTasks: number;
  }): Promise<{ id: string; runAt: number }> {
    this.#rememberInstance(req.instance);
    if (this.#count() >= req.maxTasks) {
      throw new Error(
        `Scheduled-task limit reached (${req.maxTasks}). Cancel a task or raise ` +
          "the limit in the room's resource settings."
      );
    }
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO scheduled (id, task, payload, run_at, interval_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      req.task,
      req.payload,
      req.runAt,
      req.intervalMs,
      Date.now()
    );
    await this.#arm();
    return { id, runAt: req.runAt };
  }

  /** Cancel one task by id. Returns whether a task was actually removed. */
  async cancelTask(id: string): Promise<boolean> {
    const existed = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled WHERE id = ?", id)
      .toArray()[0].n > 0;
    this.ctx.storage.sql.exec("DELETE FROM scheduled WHERE id = ?", id);
    await this.#arm();
    return existed;
  }

  /** All pending tasks, soonest first. */
  async listTasks(): Promise<ScheduledTaskInfo[]> {
    return this.ctx.storage.sql
      .exec<TaskRow>("SELECT * FROM scheduled ORDER BY run_at")
      .toArray()
      .map((r) => ({
        id: r.id,
        task: r.task,
        runAt: r.run_at,
        intervalMs: r.interval_ms,
        createdAt: r.created_at
      }));
  }

  // ── alarm: run everything due, reschedule/drop, re-arm ──

  async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec<TaskRow>("SELECT * FROM scheduled WHERE run_at <= ? ORDER BY run_at LIMIT ?", now, BATCH)
      .toArray();

    // Mutate the table BEFORE running any task: recurring tasks advance to their
    // next slot (skipping missed ones so a slow app can't cause a burst), and
    // one-shots are deleted. This way a task that throws or hangs is never
    // re-fired within the same pass.
    for (const t of due) {
      if (t.interval_ms != null) {
        let next = t.run_at + t.interval_ms;
        if (next <= now) next = now + t.interval_ms;
        this.ctx.storage.sql.exec("UPDATE scheduled SET run_at = ? WHERE id = ?", next, t.id);
      } else {
        this.ctx.storage.sql.exec("DELETE FROM scheduled WHERE id = ?", t.id);
      }
    }
    // Re-arm to the next earliest task now, so the schedule is correct regardless
    // of how long the runs below take (the gate releases during their awaits).
    await this.#arm();
    if (due.length === 0) return;

    const instance = this.#instance();
    if (!instance) return; // no owner recorded yet — nothing runnable

    const run = await this.#manifest(instance);
    if (!run) return; // app has no code (or AppHost unreachable) — skip this pass

    for (const t of due) {
      try {
        const payload = t.payload != null ? JSON.parse(t.payload) : null;
        const res = await runSchedule({
          env: this.env,
          instance,
          files: run.files,
          entrypoint: run.entrypoint,
          task: t.task,
          payload,
          resolvePrebuilt: run.resolvePrebuilt
        });
        if (!res.ok) {
          console.error(`[scheduler] task "${t.task}" failed: ${res.error}`);
        }
      } catch (err) {
        console.error(`[scheduler] task "${t.task}" threw:`, err);
      }
    }
  }

  // ── helpers ──

  /** Arm the alarm to the earliest pending run time (or clear it if none). */
  async #arm(): Promise<void> {
    const [row] = this.ctx.storage.sql
      .exec<{ next: number | null }>("SELECT MIN(run_at) AS next FROM scheduled")
      .toArray();
    if (row && row.next != null) await this.ctx.storage.setAlarm(row.next);
    else await this.ctx.storage.deleteAlarm();
  }

  #count(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled")
      .toArray()[0].n;
  }

  #rememberInstance(instance: string): void {
    if (this.#instance() === instance) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO sched_meta (k, v) VALUES ('instance', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
      instance
    );
  }

  #instance(): string | null {
    const rows = this.ctx.storage.sql
      .exec<{ v: string }>("SELECT v FROM sched_meta WHERE k = 'instance'")
      .toArray();
    return rows.length ? rows[0].v : null;
  }

  /**
   * Fetch the app's live run manifest from AppHost (files + entrypoint) plus a
   * cold-cache build resolver, so `alarm()` can run `onSchedule` on the current
   * code. Returns null if the app has no code yet or AppHost is unreachable.
   */
  async #manifest(instance: string): Promise<
    | { files: AppFile[]; entrypoint: string; resolvePrebuilt: ResolvePrebuilt }
    | null
  > {
    try {
      const host = await getAgentByName<Env, AppHost>(this.env.AppHost, instance);
      const manifest = await host.getRunManifest();
      if (!manifest.files || manifest.files.length === 0) return null;
      return {
        files: manifest.files,
        entrypoint: manifest.entrypoint,
        resolvePrebuilt: (hash: string) => host.getBuild(hash)
      };
    } catch (err) {
      console.error("[scheduler] could not load app manifest:", err);
      return null;
    }
  }
}
