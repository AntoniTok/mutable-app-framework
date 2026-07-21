import type { AppHost } from "./agent/app-host";
import type { AppData } from "./agent/app-data";
import type { AppScheduler } from "./agent/app-scheduler";
import type { AppSql } from "./agent/app-sql";
import type { CodeAssistant } from "./assistant/code-assistant";

/** Bindings available to the host worker (declared in wrangler.jsonc). */
export interface Env {
  AppHost: DurableObjectNamespace<AppHost>;
  /** The per-room agentic coding assistant (Think). One instance per room id. */
  CodeAssistant: DurableObjectNamespace<CodeAssistant>;
  /**
   * The app's isolated runtime data (key/value store + dofs filesystem), one DO
   * per room id. Reached DIRECTLY by the ScopedStore/ScopedFilesystem stubs, so
   * storage never funnels through AppHost (limitation #3).
   */
  APP_DATA: DurableObjectNamespace<AppData>;
  /**
   * The app's per-room task scheduler (broker.requestScheduler). Its OWN SQLite +
   * a Durable Object alarm fire the app's `onSchedule(env, ctx)` export later —
   * one-shot delays, absolute times, or recurring intervals. Reached DIRECTLY by
   * the ScopedScheduler stub, like APP_DATA (limitation #3).
   */
  APP_SCHEDULER: DurableObjectNamespace<AppScheduler>;
  /**
   * The app's relational SQL database (broker.requestSql), one isolated SQLite DO
   * per room id. Reached DIRECTLY by the ScopedSql stub, like APP_DATA — a real
   * SQL surface (arbitrary schema + queries) distinct from the flat key/value
   * store.
   */
  APP_SQL: DurableObjectNamespace<AppSql>;
  LOADER: WorkerLoader;
  AI: Ai;
  /** R2 bucket backing the app blob-store capability (broker.requestBlobStore). */
  BLOBS: R2Bucket;
  /** Cloudflare Email Service binding backing the app email capability
   *  (broker.requestEmail). Sends are mediated by ScopedEmail + AppHost policy. */
  EMAIL: SendEmail;
  /** Optional model override for the AI author (one-shot line-edit path). */
  AUTHOR_MODEL?: string;
  /** Optional overall timeout (ms) for one AI edit. Default 120000. */
  AUTHOR_TIMEOUT_MS?: string;
  /** Model for the Think coding assistant (tool-calling chat). Pinned in
   *  wrangler.jsonc `vars`; overridable locally via .dev.vars. */
  ASSISTANT_MODEL: string;
  /** Optional reasoning effort for the assistant model: "low" | "medium" | "high". */
  ASSISTANT_REASONING_EFFORT?: string;
}

/**
 * The subset of the AppData DO methods that the ScopedStore capability calls
 * back into over RPC. Kept as a narrow interface for documentation; the concrete
 * `AppData` class implements it.
 */
export interface AppDataStore {
  storeGet(scope: string, key: string): Promise<string | null>;
  storePut(scope: string, key: string, value: string): Promise<void>;
  storeDelete(scope: string, key: string): Promise<void>;
  storeList(scope: string): Promise<string[]>;
  /**
   * Atomic read-modify-write primitives. Each is a SINGLE DO method, so it runs
   * to completion under the AppData DO's input gate — no lost updates even under
   * concurrent HTTP requests (see limitation #2).
   */
  storeIncr(scope: string, key: string, delta: number): Promise<number>;
  storeCas(
    scope: string,
    key: string,
    expected: string | null,
    next: string
  ): Promise<boolean>;
}

/**
 * The subset of AppHost the ScopedFetcher capability calls back into: reading
 * the per-app egress allowlist AND the resolved resource limits (both trusted
 * storage, never settable by the app).
 */
export interface AppEgressPolicy {
  getEgressAllowlist(): Promise<string[]>;
  getLimits(): Promise<import("./config/limits").AppLimits>;
}

/** One secret's metadata (NEVER its value). Returned to the app/UI. */
export interface SecretInfo {
  name: string;
  /** Whether the raw value may be read by the app via `requestSecrets().get`. */
  readable: boolean;
}

/**
 * The subset of AppHost the secret-consuming capabilities call back into.
 * `resolveSecret` returns a raw value and is TRUSTED host-only (reachable by the
 * capability stubs, never by the untrusted app, which holds only `env.SYSTEM`).
 */
export interface AppSecretsPolicy {
  /** Secret NAMES + readable flags only — never values. */
  listSecrets(): Promise<SecretInfo[]>;
  /**
   * Resolve a secret's raw value (trusted). `requireReadable` gates the app-facing
   * read path (`requestSecrets().get`); host-side injection (e.g. `secretHeaders`)
   * omits it, since the value never enters the sandbox. Throws if missing (or not
   * readable when required).
   */
  resolveSecret(name: string, opts?: { requireReadable?: boolean }): Promise<string>;
}

/**
 * Per-app email policy (trusted; set via /api/email, never by the app). The app
 * may only send FROM an allowlisted address, optionally only TO allowlisted
 * recipients, and only up to the daily cap (see AppLimits.emailPerDay).
 */
export interface EmailPolicy {
  /** Allowed sender addresses. Empty => email disabled (nothing to send as). */
  allowedFrom: string[];
  /** Default sender when the app omits `from`. Falls back to allowedFrom[0]. */
  defaultFrom?: string;
  /** Optional display name applied to the sender. */
  fromName?: string;
  /**
   * Recipient allowlist: exact addresses ("a@b.com") or domains ("b.com" /
   * "*.b.com"). EMPTY => any recipient allowed (generous default).
   */
  allowRecipients: string[];
}

/** The resolved sender AppHost hands back after policy + rate reservation. */
export interface ResolvedSender {
  email: string;
  name?: string;
}

/**
 * The subset of AppHost the ScopedEmail capability calls back into. `reserveEmail`
 * validates the send against policy AND reserves a slot in the daily counter
 * (serialized on AppHost's input gate), returning the resolved sender. The slow
 * network send then happens in the stub, OFF the DO input gate.
 */
export interface AppEmailPolicy {
  reserveEmail(req: { from?: string; recipients: string[] }): Promise<ResolvedSender>;
}

/**
 * Live presence for the app-driven Room capability (broker.requestRoom). Seat
 * names come from the app's optional `seats` export; `players` maps each seat to
 * whether a connected client currently holds it; `count` is the number of
 * connected game clients (editor spectators excluded).
 */
export interface RoomPresence {
  seats: string[];
  players: Record<string, boolean>;
  count: number;
}

/**
 * The subset of AppHost the ScopedRoom capability calls back into over RPC. These
 * reach the room's live WebSocket connections (which live in AppHost, the DO that
 * owns the sockets) so the untrusted app — a pure per-request function that holds
 * no sockets — can still push to its connected clients. Each frame is wrapped as
 * `{ type: "app", data: <message> }` so it never collides with the coordinator's
 * own frames (`welcome`/`state`/`reload`). Returns the recipient count.
 */
export interface AppRoomBridge {
  appBroadcast(message: unknown): Promise<number>;
  appSendToSeat(seat: string, message: unknown): Promise<number>;
  appPresence(): Promise<RoomPresence>;
}

/**
 * One pending scheduled task, as returned to the app by `requestScheduler().list()`
 * (and stored by the AppScheduler DO). `runAt` is a ms epoch; `intervalMs` is set
 * only for recurring tasks (`every`), null for one-shots (`after`/`at`).
 */
export interface ScheduledTaskInfo {
  id: string;
  task: string;
  runAt: number;
  intervalMs: number | null;
  createdAt: number;
}

/** A value an app may BIND into a SQL statement (booleans are coerced to 0/1). */
export type SqlParam = string | number | boolean | null | ArrayBuffer;

/**
 * The result of one SQL statement run through `requestSql`. `rows` are the result
 * rows (each a column→value map); `rowsRead`/`rowsWritten` are the SQLite
 * accounting; `lastRowId` is the last inserted rowid (only set when the statement
 * wrote rows, else null).
 */
export interface SqlResult {
  rows: Record<string, SqlStorageValue>[];
  columnNames: string[];
  rowsRead: number;
  rowsWritten: number;
  lastRowId: number | null;
}

/**
 * The subset of the AppSql DO that the ScopedSql capability calls back into.
 * `exec` runs one statement (with bound params) against the app's isolated SQL
 * database and enforces the per-app guardrails (max rows per query, max DB size);
 * `setSqlLimits` receives the trusted caps pushed from AppHost.setLimits.
 */
export interface AppSqlStore {
  sqlExec(sql: string, params: SqlParam[]): Promise<SqlResult>;
  setSqlLimits(limits: { maxRows: number; maxDbBytes: number }): Promise<void>;
}

/** A node kind on the app filesystem. */
export type FsNodeType = "file" | "dir" | "symlink";

/** One directory entry returned by the filesystem capability. */
export interface FsDirent {
  name: string;
  type: FsNodeType;
}

/** Metadata for a single path (RPC-serializable subset of a dofs stat). */
export interface FsStat {
  type: FsNodeType;
  size: number;
  mtime: number;
}

/** One `grep` hit (path is namespace-relative). */
export interface FsGrepMatch {
  path: string;
  line: number;
  text: string;
}

/** One `find` result (path is namespace-relative). */
export interface FsFound {
  path: string;
  type: "file" | "dir";
}

/**
 * The subset of the AppData DO's filesystem methods the ScopedFilesystem
 * capability calls back into over RPC. Backed by @cloudflare/dofs in the AppData
 * DO. Every method is scoped by `namespace`.
 */
export interface AppFsStore {
  fsReadFile(namespace: string, path: string): Promise<string | null>;
  fsWriteFile(namespace: string, path: string, content: string): Promise<void>;
  fsReaddir(namespace: string, path: string): Promise<FsDirent[] | null>;
  fsMkdir(namespace: string, path: string): Promise<void>;
  fsRm(namespace: string, path: string, recursive: boolean): Promise<void>;
  fsStat(namespace: string, path: string): Promise<FsStat | null>;
  fsGrep(namespace: string, pattern: string, path: string): Promise<FsGrepMatch[]>;
  fsFind(namespace: string, dir: string, pattern?: string): Promise<FsFound[]>;
}
