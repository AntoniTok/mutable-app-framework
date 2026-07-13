import { WorkerEntrypoint, exports } from "cloudflare:workers";
import type { Env } from "../types";
import type { ScopedStore, ScopedStoreProps } from "./scoped-store";

/**
 * The capability broker — the ONLY power a running app starts with.
 *
 * The untrusted app cannot touch storage, secrets, or the network on its own.
 * It must call the broker and ASK. The broker validates the request, applies
 * policy, and hands back a narrow, pre-scoped capability stub.
 *
 * This is the growth point of the whole system: new resources (R2 blobs, KV,
 * realtime rooms) slot in here as new `request*` methods, without changing the
 * app contract or the runner.
 */
export type CapabilityBrokerProps = {
  instance: string;
};

// Self-referential access to this worker's exported entrypoints, used to mint
// capability stubs to hand back to the app.
type LoaderExports = {
  ScopedStore(options: { props: ScopedStoreProps }): ScopedStore;
};
const runtimeExports = exports as unknown as LoaderExports;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export class CapabilityBroker extends WorkerEntrypoint<
  Env,
  CapabilityBrokerProps
> {
  /**
   * Grant a private key/value store, backed by the app's own SQLite.
   * Available today.
   */
  async requestStore(namespace: string): Promise<ScopedStore> {
    if (!NAME_RE.test(namespace)) {
      throw new Error(
        `Invalid store namespace: "${namespace}". Use letters, digits, "-" or "_".`
      );
    }
    return runtimeExports.ScopedStore({
      props: { instance: this.ctx.props.instance, namespace }
    });
  }

  // ── RESERVED GROWTH HOOKS (documented, intentionally not implemented) ──
  //
  // Adding a resource type = bind it to the host in wrangler.jsonc + implement
  // one method here. The app contract and runner stay unchanged.
  //
  // async requestBlobStore(namespace: string) {
  //   // Backed by R2. Returns a BlobStore capability for large files
  //   // (e.g. profile pictures). Requires an R2 binding on the host.
  // }
  //
  // async requestRoom() {
  //   // Backed by the realtime coordinator. Returns a Room capability
  //   // (broadcast/send/getState) for multiplayer apps. See src/realtime/.
  // }
}
