import { Agent } from "agents";
import type { Connection, ConnectionContext, WSMessage } from "agents";
import type { Env } from "../types";
import type { AppFile } from "../templates/types";
import { getTemplate, DEFAULT_TEMPLATE_ID } from "../templates/registry";
import { WorkersAiAuthor } from "../author/workers-ai-author";
import type { CodeAuthor } from "../author/types";
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

/** How many times the AI author may retry to fix its own build errors. */
const MAX_AI_REPAIRS = 2;

/** Reserved app_data scope for the realtime engine's own state (see coordinator). */
const ROOM_SCOPE = "__room__";

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

  // Swappable AI author. Created lazily so a missing AI binding doesn't break
  // non-AI paths.
  #author?: CodeAuthor;
  #getAuthor(): CodeAuthor {
    if (!this.#author) {
      this.#author = new WorkersAiAuthor(
        this.env.AI,
        this.env.AUTHOR_MODEL,
        this.env.AUTHOR_TIMEOUT_MS
      );
    }
    return this.#author;
  }

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
      this.setState({
        ...this.state,
        activeVersion: version,
        status: "ready",
        lastError: null
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Keep the live pointer on the last good version; flag the failure.
      this.setState({ ...this.state, status: "error", lastError: message });
    }
    return version;
  }

  /** Ask the AI author to rewrite the app, then save the result (AI path). */
  async editWithAI(instruction: string): Promise<number> {
    this.setState({ ...this.state, status: "building", lastError: null });
    try {
      // Hold an alarm-backed heartbeat for the whole generation. AI edits stream
      // a model response and may run several seconds (plus self-heal retries and
      // build validations); without this the Durable Object can be idle-evicted
      // mid-flight (see the Agents SDK's keepAlive docs — AIChatAgent does the
      // same around its streams). keepAliveWhile auto-disposes on success/throw.
      return await this.keepAliveWhile(async () => {
        const template = getTemplate(this.state.templateId);
        const author = this.#getAuthor();
        const base = this.currentFilesSync();

        // Self-heal loop. Two kinds of failure are fed back to the author and
        // retried (up to MAX_AI_REPAIRS times), because both are usually a small
        // model slip:
        //   - APPLY failure — a line op referenced a nonexistent line. We
        //     re-attempt against the ORIGINAL files with the mismatch as feedback.
        //   - BUILD failure — the applied code doesn't compile. We ask the author
        //     to fix the BROKEN files with the exact build error as feedback.
        // We only save (setFiles) the final result, so retries don't spam versions.
        let candidate: AppFile[] | null = null;
        let repairBase = base;
        let feedback: string | null = null;

        for (let attempt = 0; attempt <= MAX_AI_REPAIRS; attempt++) {
          let produced: AppFile[];
          try {
            produced =
              feedback === null
                ? await author.edit({ instruction, files: base, declares: template.declares })
                : await author.repair({
                    instruction,
                    files: repairBase,
                    error: feedback,
                    declares: template.declares
                  });
          } catch (genErr) {
            // Generation/apply failure: retry against the original files.
            feedback = genErr instanceof Error ? genErr.message : String(genErr);
            repairBase = base;
            if (attempt === MAX_AI_REPAIRS) throw genErr;
            continue;
          }

          candidate = produced;
          const buildErr = await this.#buildError(produced);
          if (!buildErr) return await this.setFiles(produced, `ai: ${instruction}`);

          // Built but broken: fix the broken files next time.
          feedback = buildErr;
          repairBase = produced;
          if (attempt === MAX_AI_REPAIRS) break;
        }

        // Out of retries: save the last candidate (broken) so it can be inspected;
        // setFiles keeps the live pointer on the last good version and flags error.
        if (!candidate) throw new Error("AI produced no usable output.");
        return await this.setFiles(candidate, `ai: ${instruction}`);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Keep the previous version intact; just record the failure.
      this.setState({ ...this.state, status: "error", lastError: message });
      throw err;
    }
  }

  /** Build a file set to check it compiles; returns the error message or null. */
  async #buildError(files: AppFile[]): Promise<string | null> {
    try {
      await bundleApp(files, this.entrypoint());
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Move the live pointer to an older version. */
  async rollback(version: number): Promise<void> {
    if (!db.versionExists(this, version)) {
      throw new Error(`Version ${version} does not exist.`);
    }
    this.setState({ ...this.state, activeVersion: version });
    // Reflect whether the version we rolled back to actually builds.
    await this.validateActive();
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

  // ── app_data callbacks (invoked by ScopedStore capability over RPC) ──

  async storeGet(scope: string, key: string): Promise<string | null> {
    return db.appDataGet(this, scope, key);
  }
  async storePut(scope: string, key: string, value: string): Promise<void> {
    db.appDataPut(this, scope, key, value);
  }
  async storeDelete(scope: string, key: string): Promise<void> {
    db.appDataDelete(this, scope, key);
  }
  async storeList(scope: string): Promise<string[]> {
    return db.appDataList(this, scope);
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
