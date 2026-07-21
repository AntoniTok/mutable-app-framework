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
 *   export const stateVersion = 2                             // optional
 *   export function migrate(oldState, oldStateVersion) { ... } // optional
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
    "// Heuristic shape check: does `state` carry every top-level key the app's",
    "// initialState declares? Used by probe() when the app has no `view` to",
    "// exercise. Opaque/primitive seeds are assumed compatible.",
    "function shapeCompatible(init, state) {",
    "  if (init === null || typeof init !== 'object') return true;",
    "  if (state === null || typeof state !== 'object') return false;",
    "  for (const k of Object.keys(init)) {",
    "    if (!(k in state)) return false;",
    "  }",
    "  return true;",
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
    "  // Is `state` (persisted by an OLD code version) still usable by THIS",
    "  // version? Exercises the new code against the old state WITHOUT mutating",
    "  // it: prefer the pure `view` projection (a real read of the shape); else",
    "  // fall back to a structural check against initialState. Any throw => not",
    "  // compatible. Lets the coordinator KEEP an in-progress game across an edit.",
    "  async probe(state) {",
    "    try {",
    "      const viewFn = pick('view');",
    "      if (typeof viewFn === 'function') {",
    "        await viewFn(state, { seat: null, playerId: null });",
    "        return { ok: true, compatible: true };",
    "      }",
    "      const seed = pick('initialState');",
    "      const init = typeof seed === 'function' ? await seed() : seed;",
    "      return { ok: true, compatible: shapeCompatible(init, state) };",
    "    } catch (e) {",
    "      return { ok: true, compatible: false };",
    "    }",
    "  }",
    "  // Optional forward-migration: transform state saved by an older version",
    "  // into this version's shape. Returns { ok:false } when the app exports no",
    "  // `migrate` (the coordinator then resets to initialState).",
    "  async migrate(oldState, oldVersion) {",
    "    const fn = pick('migrate');",
    "    if (typeof fn !== 'function') return { ok: false, error: 'no-migrate' };",
    "    const next = await fn(oldState, oldVersion);",
    "    return { ok: next !== undefined, state: next };",
    "  }",
    "  // Optional app-DATA upgrade (limitation #10). Unlike `migrate` (which is a",
    "  // PURE transform of the realtime __room__ state), `onUpgrade` may do I/O:",
    "  // it gets the SAME env as fetch ({ SYSTEM }), so it can read AND rewrite the",
    "  // app's OWN store/filesystem/blob data to match the new code. The host runs",
    "  // it once per forward version change, right after a successful promote.",
    "  // `ran:false` means the app exports no onUpgrade (a no-op, not an error).",
    "  async onUpgrade(fromVersion, toVersion) {",
    "    const fn = pick('onUpgrade');",
    "    if (typeof fn !== 'function') return { ok: true, ran: false };",
    "    try {",
    "      await fn(this.env, { fromVersion, toVersion });",
    "      return { ok: true, ran: true };",
    "    } catch (e) {",
    "      return { ok: false, ran: true, error: (e && e.message) ? e.message : String(e) };",
    "    }",
    "  }",
    "  // Optional SCHEDULED-task handler (broker.requestScheduler). Runs when a",
    "  // task the app scheduled comes due — fired by the AppScheduler DO's alarm.",
    "  // Like onUpgrade it may do I/O: it gets the SAME env as fetch ({ SYSTEM }),",
    "  // so it can read/write app data, call requestFetch, or push to clients via",
    "  // requestRoom. `ran:false` means the app exports no onSchedule (a no-op).",
    "  async onSchedule(task, payload) {",
    "    const fn = pick('onSchedule');",
    "    if (typeof fn !== 'function') return { ok: true, ran: false };",
    "    try {",
    "      await fn(this.env, { task, payload });",
    "      return { ok: true, ran: true };",
    "    } catch (e) {",
    "      return { ok: false, ran: true, error: (e && e.message) ? e.message : String(e) };",
    "    }",
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

/** RPC-serializable result of a compatibility probe (see coordinator #1). */
export interface ProbeResult {
  ok: boolean;
  /** True when the probed state is usable by the current code version. */
  compatible?: boolean;
}

/** RPC-serializable result of running the app's optional `onUpgrade` (see #10). */
export interface UpgradeResult {
  /** False only when the app's onUpgrade threw (`error` explains). */
  ok: boolean;
  /** True when the app actually exports an onUpgrade (false = nothing to run). */
  ran?: boolean;
  error?: string;
}

/** RPC-serializable result of running the app's optional `onSchedule` (see #2.4). */
export interface ScheduleResult {
  /** False only when the app's onSchedule threw (`error` explains). */
  ok: boolean;
  /** True when the app actually exports an onSchedule (false = nothing to run). */
  ran?: boolean;
  error?: string;
}

/**
 * A bundled app, ready to hand straight to the Worker Loader. Produced once by
 * `bundleApp` (on promote) and persisted, so the request path never has to
 * re-run the bundler on a cold cache (see limitation #4 / AppHost build store).
 */
export interface Prebuilt {
  mainModule: string;
  modules: Record<string, string>;
}

/**
 * Resolve the stored build for a content hash, if one was persisted on promote.
 * `undefined` => no stored build; the runner falls back to bundling on demand.
 */
export type ResolvePrebuilt = (
  hash: string
) => Promise<Prebuilt | undefined> | Prebuilt | undefined;

/** Content fingerprint of a file set (also the Worker Loader cache key + build key). */
export { fingerprint };

/**
 * Bundle the app WITHOUT running it, to check that it compiles AND to capture
 * the built modules for reuse. Throws with the build error message if the code
 * is invalid (e.g. a syntax error). Used on promote to flag broken versions the
 * moment they're saved and to persist the build so the run path skips esbuild.
 */
export async function bundleApp(
  files: AppFile[],
  entrypoint: string
): Promise<Prebuilt & { warnings: string[] }> {
  const { mainModule, modules, warnings } = await createWorker({
    files: withManifest(files, entrypoint),
    entryPoint: HOST_ENTRY,
    bundle: true
  });
  return {
    mainModule,
    modules: modules as Record<string, string>,
    warnings: warnings ?? []
  };
}

/** Per-run resource limits handed to the Worker Loader (limitation #5). */
export interface RunLimits {
  cpuMs: number;
  subRequests: number;
}

/** Shared worker-code factory used by every run path (one cache entry per hash). */
function loadWorker(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
  hash: string;
  collected: { warnings: string[] };
  /** Resolve a persisted build for this hash (consulted ONLY on a cold cache). */
  resolvePrebuilt?: ResolvePrebuilt;
  /** Per-run cpu/subrequest guardrails (generous defaults; per-app configurable). */
  limits?: RunLimits;
}) {
  const { env, instance, files, entrypoint, hash, collected, resolvePrebuilt, limits } = opts;
  const workerId = `app-${instance}-${hash}`;
  const worker = env.LOADER.get(workerId, async () => {
    // Cold cache only: use the persisted build if one exists (skips the
    // bundler), else bundle on demand. Resolving the prebuilt is deferred to
    // here so warm hits pay neither the lookup nor the bundler.
    const prebuilt = resolvePrebuilt ? await resolvePrebuilt(hash) : undefined;
    let mainModule: string;
    let modules: Record<string, string>;
    if (prebuilt) {
      mainModule = prebuilt.mainModule;
      modules = prebuilt.modules;
    } else {
      const built = await createWorker({
        files: withManifest(files, entrypoint),
        entryPoint: HOST_ENTRY,
        bundle: true
      });
      mainModule = built.mainModule;
      modules = built.modules as Record<string, string>;
      collected.warnings = built.warnings ?? [];
    }
    return {
      mainModule,
      modules,
      compatibilityDate: "2026-01-01",
      compatibilityFlags: ["nodejs_compat"],
      // Per-run resource guardrails (limitation #5): bound a runaway app run's
      // CPU time and outbound subrequests. Generous defaults set by the caller
      // (see src/config/limits.ts); omitted => platform defaults apply.
      ...(limits ? { limits: { cpuMs: limits.cpuMs, subRequests: limits.subRequests } } : {}),
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

/**
 * Fingerprint the files, resolve any persisted build for that hash, and load the
 * worker. The single place the run paths share so precompiled-build lookup and
 * on-demand bundling both live in one spot.
 */
async function getWorker(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
  resolvePrebuilt?: ResolvePrebuilt;
  limits?: RunLimits;
}): Promise<{ worker: ReturnType<typeof loadWorker>["worker"]; workerId: string; collected: { warnings: string[] } }> {
  const { env, instance, files, entrypoint, resolvePrebuilt, limits } = opts;
  const hash = await fingerprint(files);
  const collected: { warnings: string[] } = { warnings: [] };
  const { worker, workerId } = loadWorker({
    env,
    instance,
    files,
    entrypoint,
    hash,
    collected,
    resolvePrebuilt,
    limits
  });
  return { worker, workerId, collected };
}

export async function runApp(opts: {
  env: Env;
  instance: string;
  version: number;
  files: AppFile[];
  entrypoint: string;
  request: Request;
  resolvePrebuilt?: ResolvePrebuilt;
  limits?: RunLimits;
}): Promise<RunResult> {
  const { env, instance, version, files, entrypoint, request, resolvePrebuilt, limits } = opts;

  const { worker, workerId, collected } = await getWorker({
    env,
    instance,
    files,
    entrypoint,
    resolvePrebuilt,
    limits
  });

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
  resolvePrebuilt?: ResolvePrebuilt;
}): Promise<ReduceResult> {
  const { env, instance, files, entrypoint, state, action, ctx, resolvePrebuilt } = opts;
  const { worker } = await getWorker({ env, instance, files, entrypoint, resolvePrebuilt });

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
  resolvePrebuilt?: ResolvePrebuilt;
}): Promise<ReduceResult> {
  const { env, instance, files, entrypoint, resolvePrebuilt } = opts;
  const { worker } = await getWorker({ env, instance, files, entrypoint, resolvePrebuilt });

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
  resolvePrebuilt?: ResolvePrebuilt;
}): Promise<ProjectResult> {
  const { env, instance, files, entrypoint, state, viewers, resolvePrebuilt } = opts;
  const { worker } = await getWorker({ env, instance, files, entrypoint, resolvePrebuilt });

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
  resolvePrebuilt?: ResolvePrebuilt;
}): Promise<SeatsResult> {
  const { env, instance, files, entrypoint, resolvePrebuilt } = opts;
  const { worker } = await getWorker({ env, instance, files, entrypoint, resolvePrebuilt });

  const logic = worker.getEntrypoint("Logic") as unknown as {
    seats(): Promise<SeatsResult>;
  };
  // `await` (not a bare return): keeps the loaded-worker stub alive until the
  // cross-worker RPC resolves.
  return await logic.seats();
}

/**
 * Ask the CURRENT app version whether `state` (persisted by an older version)
 * is still usable — see the state-preservation flow in the realtime
 * coordinator. Returns `{ ok:true, compatible:false }` on any error inside the
 * app so the caller can fall back to migrate/reset. Never throws for that.
 */
export async function probe(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
  state: unknown;
  resolvePrebuilt?: ResolvePrebuilt;
}): Promise<ProbeResult> {
  const { env, instance, files, entrypoint, state, resolvePrebuilt } = opts;
  const { worker } = await getWorker({ env, instance, files, entrypoint, resolvePrebuilt });

  const logic = worker.getEntrypoint("Logic") as unknown as {
    probe(state: unknown): Promise<ProbeResult>;
  };
  return await logic.probe(state);
}

/**
 * Run the app's optional pure `migrate(oldState, oldVersion)` export to carry
 * state forward across a breaking shape change. Returns
 * `{ ok:false, error:"no-migrate" }` when the app exports none, in which case
 * the coordinator resets to `initialState`. Never throws for a missing migrate.
 */
export async function migrate(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
  state: unknown;
  version: number;
  resolvePrebuilt?: ResolvePrebuilt;
}): Promise<ReduceResult> {
  const { env, instance, files, entrypoint, state, version, resolvePrebuilt } = opts;
  const { worker } = await getWorker({ env, instance, files, entrypoint, resolvePrebuilt });

  const logic = worker.getEntrypoint("Logic") as unknown as {
    migrate(state: unknown, version: number): Promise<ReduceResult>;
  };
  return await logic.migrate(state, version);
}

/**
 * Run the app's optional `onUpgrade(env, ctx)` export inside the sandbox to
 * migrate the app's OWN persisted data (store / filesystem / blob) across a code
 * change (limitation #10). Unlike the pure `migrate`, this runs with the app's
 * capability broker (`env.SYSTEM`), so it can read and rewrite that data. The
 * host calls this once per forward version change, right after a promote.
 * Returns `{ ok:true, ran:false }` when the app exports no `onUpgrade`.
 */
export async function runUpgrade(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
  fromVersion: number;
  toVersion: number;
  resolvePrebuilt?: ResolvePrebuilt;
}): Promise<UpgradeResult> {
  const { env, instance, files, entrypoint, fromVersion, toVersion, resolvePrebuilt } = opts;
  const { worker } = await getWorker({ env, instance, files, entrypoint, resolvePrebuilt });

  const logic = worker.getEntrypoint("Logic") as unknown as {
    onUpgrade(fromVersion: number, toVersion: number): Promise<UpgradeResult>;
  };
  return await logic.onUpgrade(fromVersion, toVersion);
}

/**
 * Run the app's optional `onSchedule(env, ctx)` export inside the sandbox when a
 * scheduled task comes due (fired by the AppScheduler DO's alarm). Like
 * `runUpgrade`, it runs with the app's capability broker (`env.SYSTEM`), so the
 * task can touch app data, fetch, or broadcast via `requestRoom`. `ctx` is
 * `{ task, payload }`. Returns `{ ok:true, ran:false }` when the app exports no
 * `onSchedule` (the scheduled task is then a harmless no-op).
 */
export async function runSchedule(opts: {
  env: Env;
  instance: string;
  files: AppFile[];
  entrypoint: string;
  task: string;
  payload: unknown;
  resolvePrebuilt?: ResolvePrebuilt;
}): Promise<ScheduleResult> {
  const { env, instance, files, entrypoint, task, payload, resolvePrebuilt } = opts;
  const { worker } = await getWorker({ env, instance, files, entrypoint, resolvePrebuilt });

  const logic = worker.getEntrypoint("Logic") as unknown as {
    onSchedule(task: string, payload: unknown): Promise<ScheduleResult>;
  };
  return await logic.onSchedule(task, payload);
}
