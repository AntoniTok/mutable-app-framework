import type { AppDataStore, AppFsStore } from "../types";

/**
 * App runtime data lives in a Durable Object FACET, not in AppHost's own SQLite.
 *
 * WHY A FACET
 * -----------
 * AppHost is the versioned, build-gated CODE repository — that is its one job.
 * The app's own runtime data (its key/value store AND its filesystem, both
 * written at runtime via `env.SYSTEM`) has the opposite lifecycle: live, mutable,
 * never rolled back. A facet gives that data:
 *   - its OWN isolated SQLite database (blast-radius isolation — a chatty app
 *     can't bloat the store that holds version history + the live pointer),
 *   - its OWN input gate (app data writes no longer serialize behind code
 *     operations and the realtime coordinator),
 *   - platform-enforced isolation (the facet cannot read AppHost's database).
 *
 * WHAT WE KEEP
 * ------------
 * Host-side MEDIATION is unchanged: the untrusted app still can't touch the
 * facet directly. It asks the broker (`requestStore` / `requestFilesystem`), gets
 * a scoped stub, and every call is validated/quota-checked/path-sanitised in
 * trusted code before AppHost forwards it into the facet. Facets add isolation;
 * the broker keeps policy. See src/capabilities/.
 *
 * THE FACET CLASS
 * ---------------
 * The class (`AppStorageFacet`, src/agent/facet/entry.ts) is trusted framework
 * code that bundles the tree-shaken @cloudflare/dofs filesystem layer. It is
 * bundled to a string by scripts/build-facet.mjs (bundle.generated.ts) and
 * delivered through the Worker Loader — facets must be obtained via
 * `worker.getDurableObjectClass(...)`. Bundling dofs into the facet also keeps it
 * OUT of the host worker's bundle.
 */

export { APP_STORAGE_FACET_SOURCE } from "./facet/bundle.generated";

/**
 * Worker Loader id for the (shared, cacheable) facet code module. Bump the
 * version suffix whenever the facet source changes so the loader reloads it.
 */
export const APP_STORAGE_FACET_WORKER_ID = "app-storage-facet-v2";

/** Facet name under AppHost (`this.ctx.facets.get(APP_STORAGE_FACET_NAME, ...)`). */
export const APP_STORAGE_FACET_NAME = "app-data";

/** The RPC surface the facet exposes: the KV store + the filesystem. */
export type AppStorageFacetStub = AppDataStore & AppFsStore;
