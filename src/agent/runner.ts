import { exports } from "cloudflare:workers";
import { createWorker } from "@cloudflare/worker-bundler";
import type { CapabilityBroker, CapabilityBrokerProps } from "../capabilities/broker";
import type { DynamicWorkerTailProps } from "../observability/dynamic-worker-tail";
import type { AppFile } from "../templates/types";
import type { Env } from "../types";

/**
 * The engine that actually runs an app.
 *
 * This is the one place that executes untrusted code, so all the sandbox rules
 * live here:
 *   - the app receives ONLY the `SYSTEM` capability broker,
 *   - `globalOutbound: null` blocks all network egress,
 *   - code is cached by a fingerprint of its contents (unchanged code = warm).
 *
 * Ways to invoke an app share ONE bundle (and one cache entry):
 *   - runApp():  serve an HTTP request via the app's default `fetch` export.
 *   - reduce():  call the app's optional pure `applyAction` export, used by the
 *                realtime coordinator. See src/realtime/coordinator.ts.
 *   - project(): call the app's optional pure `view(state, ctx)` export once per
 *                viewer (batched), so each player can be sent a DIFFERENT
 *                projection of the shared state (hidden information).
 *   - seats():   read the app's optional `seats` export (the seat names it wants
 *                the coordinator to hand out). No seat knowledge lives in core.
 *
 * Both go through a framework-INJECTED adapter (see `HOST_ENTRY`) so the
 * untrusted app only ever writes plain module exports — it never imports
 * `cloudflare:workers` or knows the adapter exists.
 */

// Self-referential access to this worker's exported entrypoints.
type LoaderExports = {
  CapabilityBroker(options: { props: CapabilityBrokerProps }): CapabilityBroker;
  DynamicWorkerTail(options: { props: DynamicWorkerTailProps }): Fetcher;
};
const runtimeExports = exports as unknown as LoaderExports;

/** Path of the framework-injected entry module inside the app bundle. */
const HOST_ENTRY = "__host_entry__.js";

/**
 * The injected adapter module. It imports the untrusted app and exposes:
 *   - `default`: the app's own default export (its `fetch` handler),
 *   - `Logic`:  a WorkerEntrypoint whose `applyAction` / `initialState` methods
 *     forward to the app's (optional) pure named exports.
 *
 * The app author writes ONLY plain exports:
 *   export default { async fetch(request, env) { ... } }
 *   export function applyAction(state, action, ctx) { ... }   // optional
 *   export const initialState = {...}  // or a function; optional
 *   export function view(state, ctx) { ... }                  // optional
 *   export const seats = ["X", "O"]                           // optional
 */
function hostEntrySource(appEntry: string): string {
  const importPath = "./" + appEntry.replace(/^\.?\//, "");
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    `import * as app from "${importPath}";`,
    "",
    "const mod = app.default ?? {};",
    "export default mod;",
    "",
    "function pick(name) {",
    "  if (typeof app[name] !== 'undefined') return app[name];",
    "  if (mod && typeof mod[name] !== 'undefined') return mod[name];",
    "  return undefined;",
    "}",
    "",
    "export class Logic extends WorkerEntrypoint {",
    "  async applyAction(state, action, ctx) {",
    "    const fn = pick('applyAction');",
    "    if (typeof fn !== 'function') return { ok: false, error: 'no-reducer' };",
    "    const next = await fn(state, action, ctx);",
    "    return { ok: true, state: next };",
    "  }",
    "  async initialState() {",
    "    const seed = pick('initialState');",
    "    const value = typeof seed === 'function' ? await seed() : seed;",
    "    return { ok: value !== undefined, state: value ?? null };",
    "  }",
    "  // Per-viewer projection. `viewers` is [{ key, ctx }]; returns a map",
    "  // key -> the state THAT viewer may see. Absent `view` export => the",
    "  // coordinator falls back to broadcasting the full state to everyone.",
    "  async views(state, viewers) {",
    "    const fn = pick('view');",
    "    if (typeof fn !== 'function') return { ok: false, error: 'no-view' };",
    "    const out = {};",
    "    const list = Array.isArray(viewers) ? viewers : [];",
    "    for (const v of list) {",
    "      out[v.key] = await fn(state, v.ctx);",
    "    }",
    "    return { ok: true, views: out };",
    "  }",
    "  // The seat names this app wants handed out (opaque to the core).",
    "  async seats() {",
    "    const value = pick('seats');",
    "    const list = typeof value === 'function' ? await value() : value;",
    "    if (!Array.isArray(list)) return { ok: false };",
    "    return { ok: true, seats: list.map(String) };",
    "  }",
    "}",
    ""
  ].join("\n");
}

async function fingerprint(files: AppFile[]): Promise<string> {
  const payload = JSON.stringify(
    [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.content])
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload)
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Build the file map handed to the bundler: the app's files, a package.json if
 * missing, and the framework-injected adapter entry.
 */
function withManifest(files: AppFile[], entrypoint: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of files) map[f.path] = f.content;
  if (!map["package.json"]) {
    map["package.json"] = JSON.stringify({ name: "mutable-app", main: HOST_ENTRY }, null, 2);
  }
  map[HOST_ENTRY] = hostEntrySource(entrypoint);
  return map;
}

export interface RunResult {
  response: Response;
  version: number;
  workerId: string;
  warnings: string[];
}

/** RPC-serializable result of a reducer call. */
export interface ReduceResult {
  ok: boolean;
  state?: unknown;
  error?: string;
}

/** One viewer to project the shared state for: an opaque key + its ctx. */
export interface Viewer {
  key: string;
  ctx: unknown;
}

/** RPC-serializable result of a batched projection call. */
export interface ProjectResult {
  ok: boolean;
  /** key -> the state that viewer may see (present only when ok). */
  views?: Record<string, unknown>;
  error?: string;
}

/** RPC-serializable result of reading the app's `seats` export. */
export interface SeatsResult {
  ok: boolean;
  seats?: string[];
}

/**
 * Bundle the app WITHOUT running it, to check that it compiles.
 * Throws with the build error message if the code is invalid (e.g. a syntax
 * error). Used to flag broken versions the moment they're saved, instead of
 * only when someone runs them.
 */
export async function bundleApp(
  files: AppFile[],
  entrypoint: string
): Promise<{ warnings: string[] }> {
  const { warnings } = await createWorker({
    files: withManifest(files, entrypoint),
    entryPoint: HOST_ENTRY,
    bundle: true
  });
  return { warnings: warnings ?? [] };
}

/** Shared worker-code factory used by both runApp and reduce (one cache entry). */
function loadWorker(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
  hash: string;
  collected: { warnings: string[] };
}) {
  const { env, instance, files, entrypoint, hash, collected } = opts;
  const workerId = `app-${instance}-${hash}`;
  const worker = env.LOADER.get(workerId, async () => {
    const { mainModule, modules, warnings } = await createWorker({
      files: withManifest(files, entrypoint),
      entryPoint: HOST_ENTRY,
      bundle: true
    });
    collected.warnings = warnings ?? [];
    return {
      mainModule,
      modules: modules as Record<string, string>,
      compatibilityDate: "2026-01-01",
      compatibilityFlags: ["nodejs_compat"],
      // The ONLY capability the untrusted app receives.
      env: {
        SYSTEM: runtimeExports.CapabilityBroker({ props: { instance } })
      },
      // Hard sandbox: no outbound network access.
      globalOutbound: null,
      // Per-run observability: the app's Dynamic Worker runs in its own context,
      // so its console.log()/exceptions/outcome would otherwise be discarded.
      // This Tail Worker (defined in the host, which has Workers Logs enabled)
      // captures them after each run and tags every entry with `workerId`.
      tails: [runtimeExports.DynamicWorkerTail({ props: { workerId } })]
    };
  });
  return { worker, workerId };
}

export async function runApp(opts: {
  env: Env;
  instance: string;
  version: number;
  files: AppFile[];
  entrypoint: string;
  request: Request;
}): Promise<RunResult> {
  const { env, instance, version, files, entrypoint, request } = opts;

  const hash = await fingerprint(files);
  const collected: { warnings: string[] } = { warnings: [] };
  const { worker, workerId } = loadWorker({ env, instance, files, entrypoint, hash, collected });

  const entry = worker.getEntrypoint() as Fetcher;
  const response = await entry.fetch(request);

  return { response, version, workerId, warnings: collected.warnings };
}

/**
 * Invoke the app's pure `applyAction(state, action, ctx)` reducer inside the
 * sandbox. Returns `{ ok:false, error:"no-reducer" }` if the app doesn't export
 * one (e.g. a non-realtime app). Never throws for a missing reducer.
 */
export async function reduce(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
  state: unknown;
  action: unknown;
  ctx: unknown;
}): Promise<ReduceResult> {
  const { env, instance, files, entrypoint, state, action, ctx } = opts;
  const hash = await fingerprint(files);
  const collected: { warnings: string[] } = { warnings: [] };
  const { worker } = loadWorker({ env, instance, files, entrypoint, hash, collected });

  const logic = worker.getEntrypoint("Logic") as unknown as {
    applyAction(state: unknown, action: unknown, ctx: unknown): Promise<ReduceResult>;
  };
  return await logic.applyAction(state, action, ctx);
}

/** Ask the app for its initial realtime state (from the optional `initialState` export). */
export async function initialState(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
}): Promise<ReduceResult> {
  const { env, instance, files, entrypoint } = opts;
  const hash = await fingerprint(files);
  const collected: { warnings: string[] } = { warnings: [] };
  const { worker } = loadWorker({ env, instance, files, entrypoint, hash, collected });

  const logic = worker.getEntrypoint("Logic") as unknown as {
    initialState(): Promise<ReduceResult>;
  };
  return await logic.initialState();
}

/**
 * Project the shared `state` for many viewers in ONE sandbox call. The app's
 * pure `view(state, ctx)` export is invoked once per viewer; the result maps
 * each viewer's key to the state that viewer may see (so each player can be sent
 * a different slice — e.g. only their own cards). Returns
 * `{ ok:false, error:"no-view" }` when the app exports no `view`, in which case
 * the coordinator broadcasts the full state unchanged. Never throws for that.
 */
export async function project(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
  state: unknown;
  viewers: Viewer[];
}): Promise<ProjectResult> {
  const { env, instance, files, entrypoint, state, viewers } = opts;
  const hash = await fingerprint(files);
  const collected: { warnings: string[] } = { warnings: [] };
  const { worker } = loadWorker({ env, instance, files, entrypoint, hash, collected });

  const logic = worker.getEntrypoint("Logic") as unknown as {
    views(state: unknown, viewers: Viewer[]): Promise<ProjectResult>;
  };
  return await logic.views(state, viewers);
}

/**
 * Read the app's optional `seats` export (the seat names it wants the
 * coordinator to hand out). Returns `{ ok:false }` when the app declares none —
 * the core owns no seat names of its own (see coordinator: no seats => everyone
 * is a spectator).
 */
export async function seats(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
}): Promise<SeatsResult> {
  const { env, instance, files, entrypoint } = opts;
  const hash = await fingerprint(files);
  const collected: { warnings: string[] } = { warnings: [] };
  const { worker } = loadWorker({ env, instance, files, entrypoint, hash, collected });

  const logic = worker.getEntrypoint("Logic") as unknown as {
    seats(): Promise<SeatsResult>;
  };
  // `await` (not a bare return): keeps the loaded-worker stub alive until the
  // cross-worker RPC resolves.
  return await logic.seats();
}
