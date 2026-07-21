import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { AppScheduler } from "../agent/app-scheduler";
import type { AppHost } from "../agent/app-host";
import type { Env, ScheduledTaskInfo } from "../types";

/**
 * A per-app task SCHEDULER handed to an app by the broker (`requestScheduler`).
 *
 * The app schedules future work — a one-shot delay (`after`), an absolute time
 * (`at`), or a recurring interval (`every`) — and the framework later runs the
 * app's `onSchedule(env, ctx)` export when each task comes due. Backed by the
 * per-room `AppScheduler` Durable Object (its OWN SQLite + a DO alarm), reached
 * DIRECTLY by this stub (2 hops, never through AppHost — limitation #3).
 *
 * The task runs in the SAME sandbox as `fetch`: it gets only `env.SYSTEM`, so it
 * can persist (`requestStore`), fetch (`requestFetch`), email (`requestEmail`) or
 * push to connected clients (`requestRoom.broadcast`) — the natural pairing that
 * makes scheduled realtime updates possible. Guardrail: the number of pending
 * tasks is capped by `maxScheduledTasks` (trusted per-app limit); delays and
 * intervals are floored to 1s to prevent alarm storms.
 */
export type ScopedSchedulerProps = {
  instance: string;
};

/** Floor for delays/intervals (mirrors AppScheduler.MIN_DELAY_MS). */
const MIN_DELAY_MS = 1_000;

const TASK_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export class ScopedScheduler extends WorkerEntrypoint<Env, ScopedSchedulerProps> {
  /** The exact AppScheduler DO this capability is scoped to (direct reach). */
  #scheduler(): DurableObjectStub<AppScheduler> {
    const id = this.env.APP_SCHEDULER.idFromName(this.ctx.props.instance);
    return this.env.APP_SCHEDULER.get(id);
  }

  /** Read the trusted per-app cap for the number of pending tasks. */
  async #maxTasks(): Promise<number> {
    const host = await getAgentByName<Env, AppHost>(this.env.AppHost, this.ctx.props.instance);
    return (await host.getLimits()).maxScheduledTasks;
  }

  #validateTask(task: unknown): string {
    if (typeof task !== "string" || !TASK_NAME_RE.test(task)) {
      throw new Error(
        'requestScheduler: `task` must be a short name (letters, digits, "._:-", ≤128 chars).'
      );
    }
    return task;
  }

  async #schedule(task: string, payload: unknown, runAt: number, intervalMs: number | null) {
    return this.#scheduler().scheduleTask({
      instance: this.ctx.props.instance,
      task,
      payload: payload === undefined ? null : JSON.stringify(payload),
      runAt,
      intervalMs,
      maxTasks: await this.#maxTasks()
    });
  }

  /**
   * Run `task` once after `delaySeconds` (min 1s). `payload` is any
   * JSON-serializable value, delivered to `onSchedule` as `ctx.payload`.
   * Returns `{ id, runAt }` — keep `id` to `cancel()` it later.
   */
  async after(delaySeconds: number, task: string, payload?: unknown): Promise<{ id: string; runAt: number }> {
    if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds)) {
      throw new Error("requestScheduler.after: delaySeconds must be a finite number.");
    }
    const delay = Math.max(MIN_DELAY_MS, Math.floor(delaySeconds * 1000));
    return this.#schedule(this.#validateTask(task), payload, Date.now() + delay, null);
  }

  /**
   * Run `task` once at an ABSOLUTE time (`unixMs`, ms since epoch). A time in the
   * past (or under the 1s floor) is clamped to ~now + 1s.
   */
  async at(unixMs: number, task: string, payload?: unknown): Promise<{ id: string; runAt: number }> {
    if (typeof unixMs !== "number" || !Number.isFinite(unixMs)) {
      throw new Error("requestScheduler.at: unixMs must be a finite epoch-millis number.");
    }
    const runAt = Math.max(Date.now() + MIN_DELAY_MS, Math.floor(unixMs));
    return this.#schedule(this.#validateTask(task), payload, runAt, null);
  }

  /**
   * Run `task` repeatedly every `intervalSeconds` (min 1s); the first run is one
   * interval from now. Recurs until you `cancel(id)`.
   */
  async every(intervalSeconds: number, task: string, payload?: unknown): Promise<{ id: string; runAt: number }> {
    if (typeof intervalSeconds !== "number" || !Number.isFinite(intervalSeconds)) {
      throw new Error("requestScheduler.every: intervalSeconds must be a finite number.");
    }
    const interval = Math.max(MIN_DELAY_MS, Math.floor(intervalSeconds * 1000));
    return this.#schedule(this.#validateTask(task), payload, Date.now() + interval, interval);
  }

  /** Cancel a scheduled task by its id. Returns whether one was removed. */
  async cancel(id: string): Promise<boolean> {
    if (typeof id !== "string" || !id) throw new Error("requestScheduler.cancel: id is required.");
    return this.#scheduler().cancelTask(id);
  }

  /** List this app's pending tasks (soonest first). */
  async list(): Promise<ScheduledTaskInfo[]> {
    return this.#scheduler().listTasks();
  }
}
