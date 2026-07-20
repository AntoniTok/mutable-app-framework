import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../types";

/**
 * A private BLOB store handed to an app by the broker (`requestBlobStore`).
 *
 * Unlike ScopedStore/ScopedFilesystem (small structured data in the app's
 * AppData DO SQLite), this is for LARGE binary objects — images, audio, exports —
 * backed by R2. It is still a capability: the app only reaches it because the
 * broker minted the stub, and every key is confined to a per-app, per-namespace
 * prefix (`<instance>/<namespace>/…`) so one app can never see another's blobs.
 *
 * The untrusted app never holds the R2 binding — this trusted entrypoint does,
 * and it prefixes/validates every key before touching the bucket.
 */
export type ScopedBlobStoreProps = {
  instance: string;
  namespace: string;
};

/** Per-object byte cap. Generous (blobs are the point) but not unbounded. */
const MAX_BLOB_BYTES = 25 * 1024 * 1024;

/** Validate an app-supplied blob key. R2 keys are flat, so there's no path
 * traversal, but we still reject control characters and cap the length. */
function safeKey(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("blob key must be a non-empty string");
  }
  if (input.includes("\0")) throw new Error("blob key must not contain null bytes");
  if (input.length > 512) throw new Error("blob key too long (max 512 chars)");
  // Disallow a leading slash so it reads cleanly under the namespace prefix.
  return input.replace(/^\/+/, "");
}

export class ScopedBlobStore extends WorkerEntrypoint<Env, ScopedBlobStoreProps> {
  #prefix(): string {
    return `${this.ctx.props.instance}/${this.ctx.props.namespace}/`;
  }

  /** Store a blob (bytes or text). Overwrites any existing object at `key`. */
  async put(key: string, value: ArrayBuffer | string): Promise<void> {
    const payload: ArrayBuffer | Uint8Array =
      typeof value === "string" ? new TextEncoder().encode(value) : value;
    if (payload.byteLength > MAX_BLOB_BYTES) {
      throw new Error(
        `Blob too large (${payload.byteLength} bytes, max ${MAX_BLOB_BYTES}).`
      );
    }
    await this.env.BLOBS.put(this.#prefix() + safeKey(key), payload);
  }

  /** Read a blob's bytes, or null if it doesn't exist. */
  async get(key: string): Promise<ArrayBuffer | null> {
    const obj = await this.env.BLOBS.get(this.#prefix() + safeKey(key));
    return obj ? await obj.arrayBuffer() : null;
  }

  /** Delete a blob. Missing keys are a no-op. */
  async delete(key: string): Promise<void> {
    await this.env.BLOBS.delete(this.#prefix() + safeKey(key));
  }

  /** List this namespace's blob keys (namespace-relative, prefix stripped). */
  async list(): Promise<string[]> {
    const prefix = this.#prefix();
    const listed = await this.env.BLOBS.list({ prefix });
    return listed.objects.map((o) => o.key.slice(prefix.length));
  }
}
