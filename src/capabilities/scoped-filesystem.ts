import { WorkerEntrypoint } from "cloudflare:workers";
import type { AppData } from "../agent/app-data";
import type { Env, FsDirent, FsFound, FsGrepMatch, FsStat } from "../types";

/**
 * A private filesystem handed to an app by the broker.
 *
 * Like ScopedStore, this is a capability: the app can only reach it because it
 * was given the stub. Every operation is scoped by `props.instance` (which app
 * = which Durable Object) and `props.namespace` (which subtree within that
 * app), so one app can never touch another's files.
 *
 * Backed by @cloudflare/dofs inside the per-room `AppData` DO's own SQLite,
 * reached DIRECTLY (not through AppHost — limitation #3). This is for small,
 * structured per-app data (notes, config, game history) — NOT a blob store.
 * Large binaries belong in R2 via the `requestBlobStore` hook.
 *
 * SECURITY: path sanitisation lives HERE, in trusted code, before anything
 * reaches the host. The app cannot escape its namespace with `..` or absolute
 * paths — every path is normalised to a namespace-relative form first.
 */
export type ScopedFilesystemProps = {
  instance: string;
  namespace: string;
};

/**
 * Normalise an app-supplied path to a safe, namespace-relative path.
 *
 * Rejects anything that could climb out of the namespace or smuggle control
 * characters. Returns a clean path WITHOUT a leading slash (the host prefixes
 * `/<namespace>` itself). Throws on an illegal path rather than silently
 * "fixing" it, so a buggy app fails loudly instead of writing somewhere
 * surprising.
 */
function safePath(input: string): string {
  if (typeof input !== "string") {
    throw new Error("path must be a string");
  }
  if (input.includes("\0")) {
    throw new Error("path must not contain null bytes");
  }
  const segments: string[] = [];
  for (const raw of input.split("/")) {
    if (raw === "" || raw === ".") continue; // collapse //, /./, leading/trailing slashes
    if (raw === "..") {
      throw new Error(`path must not contain ".." segments: ${JSON.stringify(input)}`);
    }
    segments.push(raw);
  }
  return segments.join("/");
}

export class ScopedFilesystem extends WorkerEntrypoint<Env, ScopedFilesystemProps> {
  /** The exact AppData DO this capability was scoped to (2-hop direct reach). */
  #store(): DurableObjectStub<AppData> {
    const id = this.env.APP_DATA.idFromName(this.ctx.props.instance);
    return this.env.APP_DATA.get(id);
  }

  #ns(): string {
    return this.ctx.props.namespace;
  }

  /** Read a file as UTF-8 text. Returns null if it doesn't exist. */
  async readFile(path: string): Promise<string | null> {
    return this.#store().fsReadFile(this.#ns(), safePath(path));
  }

  /** Write a file (creating parent directories as needed). Content is a string. */
  async writeFile(path: string, content: string): Promise<void> {
    if (typeof content !== "string") content = String(content);
    await this.#store().fsWriteFile(this.#ns(), safePath(path), content);
  }

  /** List a directory's entries. Returns null if the directory doesn't exist. */
  async readdir(path = ""): Promise<FsDirent[] | null> {
    return this.#store().fsReaddir(this.#ns(), safePath(path));
  }

  /** Create a directory (and any missing parents). */
  async mkdir(path: string): Promise<void> {
    await this.#store().fsMkdir(this.#ns(), safePath(path));
  }

  /** Remove a file or directory. Missing paths are a no-op. */
  async rm(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.#store().fsRm(this.#ns(), safePath(path), options.recursive ?? false);
  }

  /** Metadata for a path, or null if it doesn't exist. */
  async stat(path: string): Promise<FsStat | null> {
    return this.#store().fsStat(this.#ns(), safePath(path));
  }

  /** Search file contents under `path` for a pattern. Paths returned are namespace-relative. */
  async grep(pattern: string, path = ""): Promise<FsGrepMatch[]> {
    return this.#store().fsGrep(this.#ns(), pattern, safePath(path));
  }

  /** Find entries under `dir`, optionally filtered by a name pattern. */
  async find(dir = "", pattern?: string): Promise<FsFound[]> {
    return this.#store().fsFind(this.#ns(), safePath(dir), pattern);
  }
}
