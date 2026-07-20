import { Agent } from "agents";
import type { Connection, ConnectionContext, WSMessage } from "agents";
import type { Env } from "../types";
import type { AppFile } from "../templates/types";
import { getTemplate, DEFAULT_TEMPLATE_ID } from "../templates/registry";
import { bundleApp, runApp, runUpgrade, fingerprint } from "./runner";
import type { StoredBuild } from "./schema";
import { RoomCoordinator } from "../realtime/coordinator";
import type { ConnState, RoomHost } from "../realtime/coordinator";
import * as db from "./schema";

/**
 * AppHost — the Agent (Durable Object) that is one mutable app's permanent home.
 *
 * It is the single source of truth: it stores the app's source code and every
 * past version in its own private SQLite, keeps a small synced pointer to the
 * live version, and exposes the actions to run / edit / roll back the app.
 *
 * It knows nothing about WHICH app or WHICH AI model — it only manipulates code
 * as data through stable contracts (AppTemplate, CodeAuthor).
 *
 * It does NOT hold the app's runtime data. The app's key/value store and
 * filesystem live in a separate top-level `AppData` Durable Object (its own
 * isolated SQLite), reached directly by the capability stubs — so storage
 * traffic never funnels through this DO (limitation #3). AppHost keeps only the
 * realtime coordinator's own state (the `__room__` scope) and the trusted egress
 * allowlist (the `__egress__` scope) in its `app_data` table.
 */

export type HostStatus = "ready" | "building" | "error";

export interface HostState {
  activeVersion: number;
  status: HostStatus;
  templateId: string;
  lastError: string | null;
}

export interface PreviewResult {
  status: number;
  headers: [string, string][];
  /**
   * Raw response bytes (RPC-serializable). The host worker decodes to text only
   * when it needs to rewrite HTML; binary responses pass through untouched.
   */
  body: ArrayBuffer;
}

const DEFAULT_ENTRYPOINT = "src/index.js";

/** Reserved app_data scope for the realtime engine's own state (see coordinator). */
const ROOM_SCOPE = "__room__";

/**
 * Reserved app_data scope for the per-app egress allowlist (see ScopedFetcher).
 * Held in TRUSTED storage: the untrusted app can read it (indirectly, when a
 * fetch is checked) but can never write it — only the host `/api/egress` route
 * or a template seed sets it.
 */
const EGRESS_SCOPE = "__egress__";
const EGRESS_KEY = "allow";

/**
 * Reserved app_data scope tracking which code version the app's OWN data (store/
 * filesystem/blob) has been upgraded to (limitation #10). When a promote moves
 * the live version forward, `setFiles` runs the app's optional `onUpgrade(env,
 * ctx)` once, then advances this pointer. Held in AppHost (trusted) — the app
 * can't touch it — because AppHost is the serialized owner of the version pointer
 * and the single place a promote happens.
 */
const UPGRADE_SCOPE = "__upgrade__";
const UPGRADE_KEY = "dataVersion";

/**
 * Sentinel connection token for a READ-ONLY state subscriber (the editor chrome
 * in room.html) that watches AppHost's synced state (`activeVersion`/`status`/
 * `lastError`) live via the Agents `cf_agent_state` protocol. Such a connection
 * must NOT join the realtime game — it gets no seat and no game frames — so we
 * tag it and keep it out of the coordinator entirely (see onConnect /
 * #roomHost().roomConnections). Chosen to never collide with a real player token
 * (`?token=` is sanitized to [A-Za-z0-9_-]).
 */
const SPECTATOR_TOKEN = "__spectator__";

/**
 * How long to wait for the live version to "settle" before telling connected
 * clients to reload (see #broadcastReload). One AI turn may promote several
 * times; this coalesces that burst into a single reload so players aren't
 * interrupted repeatedly. Long enough to absorb a multi-step turn, short enough
 * that others see the change promptly. Expressed in seconds because it's backed
 * by a Durable Object ALARM (this.schedule) rather than setTimeout, so the
 * pending reload survives DO hibernation instead of being silently dropped.
 */
const RELOAD_DEBOUNCE_SECONDS = 0.75;

/** How many versions of history to retain per room (see schema.pruneVersions). */
const VERSION_HISTORY_KEEP = 50;

/** How often to sweep old version history (seconds). */
const VERSION_GC_INTERVAL_SECONDS = 24 * 60 * 60;

/** Encode a string to a standalone ArrayBuffer (RPC-serializable body). */
function encodeUtf8(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

export class AppHost extends Agent<Env, HostState> {
  initialState: HostState = {
    activeVersion: 0,
    status: "ready",
    // The one hosted app, chosen by the SINGLE source of truth in the registry.
    // Swap DEFAULT_TEMPLATE_ID there (e.g. "tictactoe" or "counter") to build a
    // different app on this framework — no other edit needed.
    templateId: DEFAULT_TEMPLATE_ID,
    lastError: null
  };

  async onStart(props?: { template?: string }): Promise<void> {
    db.createTables(this);

    // Seed once, on first boot, from the chosen template (default poker).
    if (!db.hasAnyVersion(this)) {
      const template = getTemplate(props?.template ?? this.state.templateId);
      const version = db.insertVersion(this, template.files, `seed:${template.id}`);
      // Precompile the seed so the very first request runs warm (limitation #4).
      await this.#storeBuild(template.files);
      // Seed the egress allowlist from the template (empty => no egress).
      if (template.egress && template.egress.length > 0) {
        db.appDataPut(this, EGRESS_SCOPE, EGRESS_KEY, JSON.stringify(template.egress));
      }
      // Fresh data starts already "upgraded" to the seed version — there is no
      // prior data to migrate, so onUpgrade must NOT run on the initial seed (#10).
      db.appDataPut(this, UPGRADE_SCOPE, UPGRADE_KEY, String(version));
      this.setState({
        ...this.state,
        activeVersion: version,
        templateId: template.id,
        status: "ready",
        lastError: null
      });
    }

    // Recurring version-history GC. `scheduleEvery` is idempotent, so calling it
    // on every DO wake (onStart) creates exactly one schedule, not a duplicate
    // per boot. Backed by a DO alarm.
    await this.scheduleEvery(VERSION_GC_INTERVAL_SECONDS, "gcVersions");
  }

  // ── Run the current app (preview) ──
  // Called over RPC by the host worker. We take/return plain serializable data
  // (not Request/Response objects) so this is robust across the RPC boundary.
  // The `url` path has already been stripped to the app's own path (e.g. "/inc").
  async preview(req: {
    url: string;
    method: string;
    headers: [string, string][];
    body: string | null;
  }): Promise<PreviewResult> {
    const files = this.currentFilesSync();
    if (files.length === 0) {
      return {
        status: 503,
        headers: [["content-type", "text/plain"]],
        body: encodeUtf8("No app code yet.")
      };
    }

    const request = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined
    });

    try {
      const { response } = await runApp({
        env: this.env,
        instance: this.name,
        version: this.state.activeVersion,
        files,
        entrypoint: this.entrypoint(),
        request,
        resolvePrebuilt: this.resolvePrebuilt
      });
      return {
        status: response.status,
        headers: [...response.headers.entries()],
        body: await response.arrayBuffer()
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 500,
        headers: [["content-type", "text/plain"]],
        body: encodeUtf8(`App failed to run:\n${message}`)
      };
    }
  }

  // ── Realtime (WebSocket) lifecycle ──
  //
  // Connections arrive via routeAgentRequest (/agents/app-host/<instance>) and
  // are handed to the RoomCoordinator, which owns presence/seats/broadcast and
  // drives the untrusted app's pure `applyAction` reducer through the runner.
  // The app itself never sees a socket — it stays a pure function (invariant:
  // untrusted code holds no connections and no network).

  #room?: RoomCoordinator;

  // Debounce state for the live-reload broadcast (see #broadcastReload). Holds
  // the id of the pending alarm-backed schedule so a new promote can cancel and
  // reschedule it (coalescing a burst into one reload).
  #pendingReloadScheduleId?: string;

  #coordinator(): RoomCoordinator {
    if (!this.#room) this.#room = new RoomCoordinator(this.#roomHost());
    return this.#room;
  }

  /** The narrow slice of this host the coordinator is allowed to use. */
  #roomHost(): RoomHost {
    return {
      name: this.name,
      env: this.env,
      roomFiles: () => this.currentFilesSync(),
      roomEntrypoint: () => this.entrypoint(),
      roomActiveVersion: () => this.state.activeVersion,
      broadcast: (msg) => this.broadcast(msg),
      roomConnections: () =>
        // Exclude read-only state subscribers: they aren't players, so they must
        // not count toward presence/seat-reclaim and must not receive game
        // frames. They still get `cf_agent_state` via the base Agent broadcast.
        [...(this.getConnections() as Iterable<Connection<ConnState>>)].filter(
          (c) => c.state?.token !== SPECTATOR_TOKEN
        ),
      roomGet: (k) => db.appDataGet(this, ROOM_SCOPE, k),
      roomPut: (k, v) => db.appDataPut(this, ROOM_SCOPE, k, v),
      resolvePrebuilt: this.resolvePrebuilt
    };
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url);
    // Read-only state subscriber (editor chrome): skip the coordinator so it gets
    // no seat/presence. The base Agent already sent the initial `cf_agent_state`
    // before this handler ran, and every later setState re-broadcasts it — that's
    // all this connection wants. We tag it so it's filtered from game broadcasts.
    if (url.searchParams.get("spectate") === "1") {
      (connection as Connection<ConnState>).setState({
        token: SPECTATOR_TOKEN,
        seat: null
      });
      return;
    }
    const token = url.searchParams.get("token") || crypto.randomUUID();
    await this.#coordinator().onConnect(connection as Connection<ConnState>, token);
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return; // JSON text frames only
    // State subscribers are read-only — they never drive game actions.
    if ((connection as Connection<ConnState>).state?.token === SPECTATOR_TOKEN) return;
    await this.#coordinator().onMessage(connection as Connection<ConnState>, message);
  }

  async onClose(connection: Connection): Promise<void> {
    // A state subscriber was never a player, so there's no presence to refresh.
    if ((connection as Connection<ConnState>).state?.token === SPECTATOR_TOKEN) return;
    await this.#coordinator().onClose(connection as Connection<ConnState>);
  }

  // ── File management actions (called over RPC by the host worker) ──

  async getFiles(): Promise<AppFile[]> {
    return this.currentFilesSync();
  }

  /**
   * The minimal code needed to RUN the live app: its files, entry, and version.
   * The host worker calls this, then runs the app itself (streaming the
   * response) — so the app's HTTP data path no longer flows through this DO.
   * See server.ts handlePreview.
   */
  async getRunManifest(): Promise<{ files: AppFile[]; entrypoint: string; version: number }> {
    return {
      files: this.currentFilesSync(),
      entrypoint: this.entrypoint(),
      version: this.state.activeVersion
    };
  }

  /** Look up a persisted build by content hash (used as the runner's cold-cache
   *  prebuilt resolver from the host worker). */
  async getBuild(hash: string): Promise<StoredBuild | undefined> {
    return db.getBuild(this, hash);
  }

  async getStatus(): Promise<HostState> {
    return this.state;
  }

  async listVersions(): Promise<db.VersionRow[]> {
    return db.listVersions(this);
  }

  /** Re-seed the app from its template as a new version (a clean slate). */
  async resetToTemplate(): Promise<number> {
    const template = getTemplate(this.state.templateId);
    return this.setFiles(template.files, `reset:${template.id}`);
  }

  /**
   * Save a new version from an explicit file set (manual editor path).
   *
   * The version is ALWAYS persisted (so a broken one can be inspected or rolled
   * back to), but the live pointer only advances if the code actually builds.
   * A version that fails to build is saved and returned, but the live app keeps
   * running the last good version — we never promote a broken build.
   */
  async setFiles(files: AppFile[], note = "manual edit"): Promise<number> {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("At least one file is required.");
    }
    // Save first, unconditionally, so the version exists regardless of outcome.
    const version = db.insertVersion(this, files, note);

    // Validate by building. Only promote to live if the build succeeds. On
    // success we persist the build (keyed by content hash) so the request path
    // never re-runs the bundler on a cold cache (limitation #4).
    try {
      const built = await bundleApp(files, this.entrypoint());
      db.putBuild(this, await fingerprint(files), built.mainModule, built.modules);
      const previousVersion = this.state.activeVersion;
      this.setState({
        ...this.state,
        activeVersion: version,
        status: "ready",
        lastError: null
      });
      // Now that the new code is live, give it a chance to migrate the app's OWN
      // persisted data (store/fs/blob) to the new shape (limitation #10). Runs
      // once per forward promote, serialized here on AppHost's input gate.
      await this.#runDataUpgrade(version);
      // The live code changed. Tell every connected client to reload so it picks
      // up the new page/app — otherwise only the tab that made the edit (which
      // reloads its own preview) would see it; everyone else would run stale code
      // until a manual refresh. Skip the very first seed (nothing to reload yet).
      if (previousVersion !== version && previousVersion !== 0) {
        await this.#broadcastReload(version);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Keep the live pointer on the last good version; flag the failure.
      this.setState({ ...this.state, status: "error", lastError: message });
    }
    return version;
  }

  /** Move the live pointer to an older version. */
  async rollback(version: number): Promise<void> {
    if (!db.versionExists(this, version)) {
      throw new Error(`Version ${version} does not exist.`);
    }
    const previousVersion = this.state.activeVersion;
    this.setState({ ...this.state, activeVersion: version });
    // Reflect whether the version we rolled back to actually builds.
    await this.validateActive();
    // Rolling back also changes the live code — propagate to all clients.
    if (previousVersion !== version) await this.#broadcastReload(version);
  }

  /**
   * Tell every connected client the live version changed so it reloads and runs
   * the new code. The realtime channel normally carries only game STATE, so
   * without this signal other players keep executing the previously-loaded page
   * until a manual refresh. A client that reconnects re-seeds fresh state via the
   * coordinator's version check. Apps opt in by handling the reserved
   * `{ type: "reload" }` frame (the example templates do).
   *
   * DEBOUNCED: a single AI turn can promote more than once (e.g. a save plus a
   * follow-up fix). Reloading players on each promote would flicker/interrupt
   * them repeatedly, so we coalesce a burst into ONE reload on the LATEST good
   * version, fired only after `RELOAD_DEBOUNCE_SECONDS` of quiet. Each new promote
   * cancels the pending schedule and re-arms it.
   *
   * Backed by a Durable Object alarm (`this.schedule`) rather than `setTimeout`:
   * a plain timer is lost if the DO hibernates during the debounce window, which
   * would silently drop the reload; the alarm survives hibernation.
   */
  async #broadcastReload(version: number): Promise<void> {
    if (this.#pendingReloadScheduleId) {
      await this.cancelSchedule(this.#pendingReloadScheduleId);
      this.#pendingReloadScheduleId = undefined;
    }
    const scheduled = await this.schedule(RELOAD_DEBOUNCE_SECONDS, "flushReload", { version });
    this.#pendingReloadScheduleId = scheduled.id;
  }

  /**
   * Alarm callback: emit the coalesced reload frame for the latest good version.
   * Invoked by the Agent scheduler (not RPC). Named (not #private) because
   * `this.schedule(..., callback)` references it by key.
   */
  flushReload(payload: { version: number }): void {
    this.#pendingReloadScheduleId = undefined;
    this.broadcast(JSON.stringify({ type: "reload", version: payload.version }));
  }

  /**
   * Alarm callback: prune old version history so `files`/`versions` can't grow
   * without bound. Keeps the newest `VERSION_HISTORY_KEEP` versions plus the
   * active one. Invoked by the recurring schedule armed in onStart.
   */
  gcVersions(): void {
    db.pruneVersions(this, VERSION_HISTORY_KEEP, this.state.activeVersion);
    // Keep the build cache bounded alongside version history.
    db.pruneBuilds(this, VERSION_HISTORY_KEEP);
  }

  /**
   * Bundle `files` and persist the result keyed by content hash, so a later run
   * (even after hibernation, when the Worker Loader cache is cold) can load the
   * modules directly instead of re-running esbuild. Best-effort: a build failure
   * is swallowed here (setFiles is the path that surfaces build errors).
   */
  async #storeBuild(files: AppFile[]): Promise<void> {
    try {
      const built = await bundleApp(files, this.entrypoint());
      db.putBuild(this, await fingerprint(files), built.mainModule, built.modules);
    } catch {
      // Ignore — the on-demand bundler in the runner is the fallback.
    }
  }

  /**
   * Resolve a persisted build for a content hash (passed to the runner so it can
   * skip bundling). An arrow property so it can be handed off as a callback
   * without losing `this`.
   */
  resolvePrebuilt = (hash: string): StoredBuild | undefined => db.getBuild(this, hash);

  /**
   * Run the app's optional `onUpgrade(env, ctx)` to migrate its OWN persisted
   * data (store/fs/blob) after the live version moved FORWARD to `toVersion`
   * (limitation #10). Forward-only and idempotent-per-version: we track the last
   * version the data was upgraded to (`__upgrade__`), skip when the target isn't
   * ahead of it, and only advance the pointer when the upgrade succeeds — so a
   * failed upgrade retries on the next promote (from the same base version).
   *
   * The code is already promoted (the build passed); a failing onUpgrade does
   * NOT un-promote it, but it flips `status` to "error" with a clear message so
   * the developer sees the data migration needs attention.
   */
  async #runDataUpgrade(toVersion: number): Promise<void> {
    const stored = db.appDataGet(this, UPGRADE_SCOPE, UPGRADE_KEY);
    const fromVersion = stored === null ? 0 : Number(stored);
    // Only migrate forward. Rollbacks (which don't go through here) and re-runs
    // of an already-migrated version are no-ops.
    if (!(toVersion > fromVersion)) return;

    try {
      const result = await runUpgrade({
        env: this.env,
        instance: this.name,
        files: this.currentFilesSync(),
        entrypoint: this.entrypoint(),
        fromVersion,
        toVersion,
        resolvePrebuilt: this.resolvePrebuilt
      });
      if (result.ok) {
        // Success (or the app exports no onUpgrade at all) — the data is now
        // current for this version; advance the pointer so it won't re-run.
        db.appDataPut(this, UPGRADE_SCOPE, UPGRADE_KEY, String(toVersion));
      } else {
        // The app's onUpgrade threw. Keep the code promoted, leave the pointer
        // behind (so the next promote retries), and surface the failure.
        this.setState({
          ...this.state,
          status: "error",
          lastError: `Data upgrade failed (v${fromVersion}→v${toVersion}): ${result.error ?? "unknown error"}`
        });
      }
    } catch (err) {
      // The sandbox call itself failed (not the app throwing) — same handling.
      const message = err instanceof Error ? err.message : String(err);
      this.setState({
        ...this.state,
        status: "error",
        lastError: `Data upgrade could not run (v${fromVersion}→v${toVersion}): ${message}`
      });
    }
  }

  /** Try to build the live version; set status to ready or error accordingly. */
  private async validateActive(): Promise<void> {
    try {
      await bundleApp(this.currentFilesSync(), this.entrypoint());
      this.setState({ ...this.state, status: "ready", lastError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ ...this.state, status: "error", lastError: message });
    }
  }

  // ── egress allowlist (trusted policy; read by ScopedFetcher, written only
  //    by the host /api/egress route) ──

  /** The hosts this app may reach via `env.SYSTEM.requestFetch()`. */
  async getEgressAllowlist(): Promise<string[]> {
    const raw = db.appDataGet(this, EGRESS_SCOPE, EGRESS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  /** Replace the app's egress allowlist (host-only; not reachable by the app). */
  async setEgressAllowlist(list: string[]): Promise<string[]> {
    const clean = Array.isArray(list)
      ? list.map((s) => String(s).trim().toLowerCase()).filter((s) => s.length > 0)
      : [];
    db.appDataPut(this, EGRESS_SCOPE, EGRESS_KEY, JSON.stringify(clean));
    return clean;
  }

  // ── internals ──

  private currentFilesSync(): AppFile[] {
    return db.getFiles(this, this.state.activeVersion);
  }

  private entrypoint(): string {
    const template = getTemplate(this.state.templateId);
    return template.entrypoint ?? DEFAULT_ENTRYPOINT;
  }
}
