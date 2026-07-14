import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { AppFsStore, Env, FsDirent, FsFound, FsGrepMatch, FsStat } from "../types";

/**
 * A private filesystem handed to an app by the broker.
 *
 * Like ScopedStore, this is a capability: the app can only reach it because it
 * was given the stub. Every operation is scoped by `props.instance` (which app
 * = which Durable Object) and `props.namespace` (which subtree within that
 * app), so one app can never touch another's files.
 *
 * Backed by @cloudflare/dofs inside the AppHost's own SQLite. This is for small,
 * structured per-app data (notes, config, game history) — NOT a blob store.
 * Large binaries belong in R2 via a future `requestBlobStore` hook.
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
  #host(): Promise<AppFsStore> {
    // Reach the exact AppHost instance this capability was scoped to.
    return getAgentByName(
      this.env.AppHost,
      this.ctx.props.instance
    ) as unknown as Promise<AppFsStore>;
  }

  #ns(): string {
    return this.ctx.props.namespace;
  }

  /** Read a file as UTF-8 text. Returns null if it doesn't exist. */
  async readFile(path: string): Promise<string | null> {
    const host = await this.#host();
    return host.fsReadFile(this.#ns(), safePath(path));
  }

  /** Write a file (creating parent directories as needed). Content is a string. */
  async writeFile(path: string, content: string): Promise<void> {
    if (typeof content !== "string") content = String(content);
    const host = await this.#host();
    await host.fsWriteFile(this.#ns(), safePath(path), content);
  }

  /** List a directory's entries. Returns null if the directory doesn't exist. */
  async readdir(path = ""): Promise<FsDirent[] | null> {
    const host = await this.#host();
    return host.fsReaddir(this.#ns(), safePath(path));
  }

  /** Create a directory (and any missing parents). */
  async mkdir(path: string): Promise<void> {
    const host = await this.#host();
    await host.fsMkdir(this.#ns(), safePath(path));
  }

  /** Remove a file or directory. Missing paths are a no-op. */
  async rm(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const host = await this.#host();
    await host.fsRm(this.#ns(), safePath(path), options.recursive ?? false);
  }

  /** Metadata for a path, or null if it doesn't exist. */
  async stat(path: string): Promise<FsStat | null> {
    const host = await this.#host();
    return host.fsStat(this.#ns(), safePath(path));
  }

  /** Search file contents under `path` for a pattern. Paths returned are namespace-relative. */
  async grep(pattern: string, path = ""): Promise<FsGrepMatch[]> {
    const host = await this.#host();
    return host.fsGrep(this.#ns(), pattern, safePath(path));
  }

  /** Find entries under `dir`, optionally filtered by a name pattern. */
  async find(dir = "", pattern?: string): Promise<FsFound[]> {
    const host = await this.#host();
    return host.fsFind(this.#ns(), safePath(dir), pattern);
  }
}
