import { Agent } from "agents";
import type { Connection, ConnectionContext, WSMessage } from "agents";
import type { Env, FsDirent, FsFound, FsGrepMatch, FsStat } from "../types";
import type { AppFile } from "../templates/types";
import { getTemplate, DEFAULT_TEMPLATE_ID } from "../templates/registry";
import {
  APP_STORAGE_FACET_NAME,
  APP_STORAGE_FACET_SOURCE,
  APP_STORAGE_FACET_WORKER_ID,
  type AppStorageFacetStub
} from "./app-storage-facet";
import { bundleApp, runApp } from "./runner";
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
 * How long to wait for the live version to "settle" before telling connected
 * clients to reload (see #broadcastReload). One AI turn may promote several
 * times; this coalesces that burst into a single reload so players aren't
 * interrupted repeatedly. Long enough to absorb a multi-step turn, short enough
 * that others see the change promptly.
 */
const RELOAD_DEBOUNCE_MS = 750;

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
      this.setState({
        ...this.state,
        activeVersion: version,
        templateId: template.id,
        status: "ready",
        lastError: null
      });
    }
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
        request
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

  // Debounce state for the live-reload broadcast (see #broadcastReload).
  #reloadTimer?: ReturnType<typeof setTimeout>;
  #pendingReloadVersion?: number;

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
        this.getConnections() as Iterable<Connection<ConnState>>,
      roomGet: (k) => db.appDataGet(this, ROOM_SCOPE, k),
      roomPut: (k, v) => db.appDataPut(this, ROOM_SCOPE, k, v)
    };
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get("token") || crypto.randomUUID();
    await this.#coordinator().onConnect(connection as Connection<ConnState>, token);
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return; // JSON text frames only
    await this.#coordinator().onMessage(connection as Connection<ConnState>, message);
  }

  async onClose(connection: Connection): Promise<void> {
    await this.#coordinator().onClose(connection as Connection<ConnState>);
  }

  // ── File management actions (called over RPC by the host worker) ──

  async getFiles(): Promise<AppFile[]> {
    return this.currentFilesSync();
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

    // Validate by building. Only promote to live if the build succeeds.
    try {
      await bundleApp(files, this.entrypoint());
      const previousVersion = this.state.activeVersion;
      this.setState({
        ...this.state,
        activeVersion: version,
        status: "ready",
        lastError: null
      });
      // The live code changed. Tell every connected client to reload so it picks
      // up the new page/app — otherwise only the tab that made the edit (which
      // reloads its own preview) would see it; everyone else would run stale code
      // until a manual refresh. Skip the very first seed (nothing to reload yet).
      if (previousVersion !== version && previousVersion !== 0) {
        this.#broadcastReload(version);
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
    if (previousVersion !== version) this.#broadcastReload(version);
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
   * version, fired only after `RELOAD_DEBOUNCE_MS` of quiet. Each new promote
   * resets the timer.
   */
  #broadcastReload(version: number): void {
    this.#pendingReloadVersion = version;
    if (this.#reloadTimer !== undefined) clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = undefined;
      const v = this.#pendingReloadVersion;
      this.#pendingReloadVersion = undefined;
      if (v !== undefined) this.broadcast(JSON.stringify({ type: "reload", version: v }));
    }, RELOAD_DEBOUNCE_MS);
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

  // ── app runtime data (invoked by the ScopedStore / ScopedFilesystem
  //    capabilities over RPC) ──
  //
  // ALL of an app's runtime data — its key/value store AND its filesystem — lives
  // in a FACET: a child Durable Object with its own isolated SQLite, separate
  // from this supervisor's code/version store. These methods are the trusted
  // forwarding layer: the broker's scoped stubs have already validated,
  // quota-checked, and path-sanitised the call (see src/capabilities/), and
  // AppHost forwards it into the facet. AppHost never exposes the facet directly,
  // so host-side mediation is preserved while storage is isolated. (Only the
  // realtime coordinator's own state stays in AppHost's SQLite, under __room__.)

  /**
   * Get (or resume) the app-data facet and return its RPC stub. `facets.get`
   * only runs the callback on a cold/hibernated facet; otherwise it reuses the
   * running one. The facet class is trusted framework code (it bundles the
   * tree-shaken dofs filesystem layer) loaded through the Worker Loader — facets
   * must come from `getDurableObjectClass`. `nodejs_compat` is required because
   * dofs uses node:crypto/node:events.
   */
  #appData(): AppStorageFacetStub {
    const env = this.env;
    const facet = this.ctx.facets.get(APP_STORAGE_FACET_NAME, () => {
      const worker = env.LOADER.get(APP_STORAGE_FACET_WORKER_ID, () => ({
        compatibilityDate: "2026-01-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "facet.js",
        modules: { "facet.js": APP_STORAGE_FACET_SOURCE },
        // Trusted, but it needs no network — keep the hard sandbox default.
        globalOutbound: null
      }));
      return { class: worker.getDurableObjectClass("AppStorageFacet") };
    });
    return facet as unknown as AppStorageFacetStub;
  }

  // key/value store
  async storeGet(scope: string, key: string): Promise<string | null> {
    return this.#appData().storeGet(scope, key);
  }
  async storePut(scope: string, key: string, value: string): Promise<void> {
    await this.#appData().storePut(scope, key, value);
  }
  async storeDelete(scope: string, key: string): Promise<void> {
    await this.#appData().storeDelete(scope, key);
  }
  async storeList(scope: string): Promise<string[]> {
    return this.#appData().storeList(scope);
  }

  // filesystem (dofs runs inside the facet; these just forward)
  async fsReadFile(namespace: string, path: string): Promise<string | null> {
    return this.#appData().fsReadFile(namespace, path);
  }
  async fsWriteFile(namespace: string, path: string, content: string): Promise<void> {
    await this.#appData().fsWriteFile(namespace, path, content);
  }
  async fsReaddir(namespace: string, path: string): Promise<FsDirent[] | null> {
    return this.#appData().fsReaddir(namespace, path);
  }
  async fsMkdir(namespace: string, path: string): Promise<void> {
    await this.#appData().fsMkdir(namespace, path);
  }
  async fsRm(namespace: string, path: string, recursive: boolean): Promise<void> {
    await this.#appData().fsRm(namespace, path, recursive);
  }
  async fsStat(namespace: string, path: string): Promise<FsStat | null> {
    return this.#appData().fsStat(namespace, path);
  }
  async fsGrep(namespace: string, pattern: string, path: string): Promise<FsGrepMatch[]> {
    return this.#appData().fsGrep(namespace, pattern, path);
  }
  async fsFind(namespace: string, dir: string, pattern?: string): Promise<FsFound[]> {
    return this.#appData().fsFind(namespace, dir, pattern);
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
