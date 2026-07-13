import type { AppHost } from "./agent/app-host";

/** Bindings available to the host worker (declared in wrangler.jsonc). */
export interface Env {
  AppHost: DurableObjectNamespace<AppHost>;
  LOADER: WorkerLoader;
  AI: Ai;
  /** Optional model override for the AI author. */
  AUTHOR_MODEL?: string;
  /** Optional overall timeout (ms) for one AI edit. Default 120000. */
  AUTHOR_TIMEOUT_MS?: string;
}

/**
 * The subset of AppHost methods that capability stubs call back into over RPC.
 * Keeping this as a narrow interface avoids a circular import on the class.
 */
export interface AppDataStore {
  storeGet(scope: string, key: string): Promise<string | null>;
  storePut(scope: string, key: string, value: string): Promise<void>;
  storeDelete(scope: string, key: string): Promise<void>;
  storeList(scope: string): Promise<string[]>;
}
