import type { AppHost } from "./agent/app-host";
import type { AppData } from "./agent/app-data";
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
  LOADER: WorkerLoader;
  AI: Ai;
  /** R2 bucket backing the app blob-store capability (broker.requestBlobStore). */
  BLOBS: R2Bucket;
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
 * the per-app egress allowlist (trusted storage, never settable by the app).
 */
export interface AppEgressPolicy {
  getEgressAllowlist(): Promise<string[]>;
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
