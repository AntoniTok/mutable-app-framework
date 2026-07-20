import { DurableObject } from "cloudflare:workers";
import {
  Database,
  type DurableObjectStorageLike,
  initializeSchema,
  WorkspaceFilesystem,
  type WorkspaceFsError
} from "@cloudflare/dofs";
import type {
  AppDataStore,
  AppFsStore,
  Env,
  FsDirent,
  FsFound,
  FsGrepMatch,
  FsNodeType,
  FsStat
} from "../types";

/**
 * AppData — the isolated, TOP-LEVEL home for ALL of an app's runtime data.
 *
 * This is a Durable Object keyed by the app instance (room id). It has its OWN
 * SQLite database, separate from AppHost's code/version store, so the app's live
 * data (a chatty writer) can never bloat or contend with the version repository
 * or the realtime coordinator. AppHost cannot read this database and this DO
 * cannot read AppHost's — isolation is enforced by the platform.
 *
 * It holds two things, both scoped by an app-supplied namespace:
 *   - a key/value STORE (`store*`) over its own `ctx.storage.sql`, and
 *   - a virtual FILESYSTEM (`fs*`) via @cloudflare/dofs over the same storage.
 *
 * HOW IT'S REACHED (limitation #3 — 2 hops, no funneling)
 * -------------------------------------------------------
 * The untrusted app never reaches this class directly. It asks the broker
 * (`env.SYSTEM.requestStore` / `requestFilesystem`), which validates + scopes the
 * request and hands back a capability stub. That stub (ScopedStore /
 * ScopedFilesystem) then talks DIRECTLY to this DO by name —
 * `env.APP_DATA.get(idFromName(instance))` — so the data path is exactly two
 * hops (app → scoped stub → AppData) and NEVER passes through AppHost. AppHost is
 * left free to serve code + the realtime coordinator without storage traffic
 * contending on its input gate.
 *
 * This DO adds ISOLATION; the broker's scoped stubs keep POLICY
 * (quota/scope/path-sanitisation). See src/capabilities/.
 *
 * (Earlier this logic lived in a Durable Object FACET beneath AppHost; that gave
 * the same isolated SQLite but forced a third hop through AppHost, because a
 * facet is only reachable via its parent's `ctx.facets.get`. Promoting it to a
 * top-level DO drops that hop. The full history is in
 * docs/cloudflare-sdk-usage.md.)
 */

/**
 * Per-file byte cap for the filesystem. Deliberately modest (256 KiB): this is
 * for small, structured per-app data (notes, config, game history), NOT a blob
 * store. Large binaries belong in R2 via the `requestBlobStore` broker hook.
 */
const MAX_FS_FILE_BYTES = 256 * 1024;

/** True when a dofs error means "no such file/dir". */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Partial<WorkspaceFsError>).code === "ENOENT"
  );
}

/** Collapse a dofs node's type booleans into a simple tag. */
function direntType(node: {
  isDirectory: boolean;
  isSymbolicLink: boolean;
}): FsNodeType {
  if (node.isDirectory) return "dir";
  if (node.isSymbolicLink) return "symlink";
  return "file";
}

export class AppData extends DurableObject<Env> implements AppDataStore, AppFsStore {
  #fs?: WorkspaceFilesystem;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Idempotent: this DO's OWN SQLite (isolated from AppHost's code store).
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS app_data (scope TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (scope, k))"
    );
  }

  // ── key/value store (invoked by ScopedStore over RPC) ──

  async storeGet(scope: string, key: string): Promise<string | null> {
    const rows = this.ctx.storage.sql
      .exec<{ v: string }>(
        "SELECT v FROM app_data WHERE scope = ? AND k = ?",
        scope,
        key
      )
      .toArray();
    return rows.length ? rows[0].v : null;
  }

  async storePut(scope: string, key: string, value: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO app_data (scope, k, v) VALUES (?, ?, ?) ON CONFLICT (scope, k) DO UPDATE SET v = excluded.v",
      scope,
      key,
      value
    );
  }

  async storeDelete(scope: string, key: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM app_data WHERE scope = ? AND k = ?",
      scope,
      key
    );
  }

  async storeList(scope: string): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ k: string }>(
        "SELECT k FROM app_data WHERE scope = ? ORDER BY k",
        scope
      )
      .toArray()
      .map((r) => r.k);
  }

  /**
   * Atomically add `delta` to a numeric value and return the new total. A
   * missing key starts at 0. This whole method runs under the DO's input gate
   * (no `await` splits it), so concurrent increments can't lose updates — the
   * fix for the read-modify-write race on the plain HTTP path (limitation #2).
   */
  async storeIncr(scope: string, key: string, delta: number): Promise<number> {
    const rows = this.ctx.storage.sql
      .exec<{ v: string }>(
        "SELECT v FROM app_data WHERE scope = ? AND k = ?",
        scope,
        key
      )
      .toArray();
    const current = rows.length ? Number(rows[0].v) : 0;
    if (!Number.isFinite(current)) {
      throw new Error(`storeIncr: value at "${key}" is not numeric ("${rows[0].v}").`);
    }
    const next = current + delta;
    this.ctx.storage.sql.exec(
      "INSERT INTO app_data (scope, k, v) VALUES (?, ?, ?) ON CONFLICT (scope, k) DO UPDATE SET v = excluded.v",
      scope,
      key,
      String(next)
    );
    return next;
  }

  /**
   * Atomic compare-and-swap: write `next` only if the current value equals
   * `expected` (`null` means "the key must be absent"). Returns whether the swap
   * happened. Lets an app build its own safe read-modify-write loops.
   */
  async storeCas(
    scope: string,
    key: string,
    expected: string | null,
    next: string
  ): Promise<boolean> {
    const rows = this.ctx.storage.sql
      .exec<{ v: string }>(
        "SELECT v FROM app_data WHERE scope = ? AND k = ?",
        scope,
        key
      )
      .toArray();
    const current = rows.length ? rows[0].v : null;
    if (current !== expected) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO app_data (scope, k, v) VALUES (?, ?, ?) ON CONFLICT (scope, k) DO UPDATE SET v = excluded.v",
      scope,
      key,
      next
    );
    return true;
  }

  // ── filesystem (invoked by ScopedFilesystem over RPC) ──
  //
  // Backed by @cloudflare/dofs: a SQLite-backed virtual filesystem living in
  // THIS DO's own storage (the vfs_* tables sit beside our app_data table).
  // Only the local filesystem layer is used (Database + WorkspaceFilesystem);
  // dofs's sync/RPC/git machinery is tree-shaken out at bundle time.
  //
  // Each app namespace gets its own subtree under `/<namespace>`. The broker's
  // ScopedFilesystem has already sanitised the path (no `..`, no leading slash);
  // we scope again here by prefixing, so all of an app's bytes stay in its tree.

  #filesystem(): WorkspaceFilesystem {
    if (!this.#fs) {
      const storage = this.ctx.storage as unknown as DurableObjectStorageLike;
      const database = new Database(storage);
      initializeSchema(database, Date.now);
      this.#fs = new WorkspaceFilesystem(database);
    }
    return this.#fs;
  }

  #fsPath(namespace: string, path: string): string {
    const rel = path.replace(/^\/+/, "");
    return rel ? `/${namespace}/${rel}` : `/${namespace}`;
  }

  #fsUnscope(namespace: string, absolutePath: string): string {
    const root = `/${namespace}`;
    if (absolutePath === root) return "/";
    return absolutePath.startsWith(`${root}/`)
      ? absolutePath.slice(root.length)
      : absolutePath;
  }

  async fsReadFile(namespace: string, path: string): Promise<string | null> {
    try {
      return await this.#filesystem().readFile(this.#fsPath(namespace, path), "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async fsWriteFile(namespace: string, path: string, content: string): Promise<void> {
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > MAX_FS_FILE_BYTES) {
      throw new Error(
        `File too large (${bytes} bytes, max ${MAX_FS_FILE_BYTES}). ` +
          "This filesystem is for small structured data, not large blobs."
      );
    }
    const fs = this.#filesystem();
    const absolute = this.#fsPath(namespace, path);
    // dofs never auto-creates parents; create the directory chain first.
    const parent = absolute.slice(0, absolute.lastIndexOf("/")) || "/";
    if (parent !== "/") await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(absolute, content);
  }

  async fsReaddir(namespace: string, path: string): Promise<FsDirent[] | null> {
    try {
      const entries = await this.#filesystem().readdir(this.#fsPath(namespace, path));
      return entries.map((e) => ({ name: e.name, type: direntType(e) }));
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async fsMkdir(namespace: string, path: string): Promise<void> {
    await this.#filesystem().mkdir(this.#fsPath(namespace, path), { recursive: true });
  }

  async fsRm(namespace: string, path: string, recursive: boolean): Promise<void> {
    await this.#filesystem().rm(this.#fsPath(namespace, path), { recursive, force: true });
  }

  async fsStat(namespace: string, path: string): Promise<FsStat | null> {
    try {
      const s = await this.#filesystem().stat(this.#fsPath(namespace, path));
      return { type: direntType(s), size: s.size, mtime: s.mtime };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async fsGrep(namespace: string, pattern: string, path: string): Promise<FsGrepMatch[]> {
    const matches = await this.#filesystem().grep(pattern, this.#fsPath(namespace, path));
    return matches.map((m) => ({
      path: this.#fsUnscope(namespace, m.path),
      line: m.line,
      text: m.text
    }));
  }

  async fsFind(namespace: string, dir: string, pattern?: string): Promise<FsFound[]> {
    const found = await this.#filesystem().find(this.#fsPath(namespace, dir), pattern);
    return found.map((f) => ({ path: this.#fsUnscope(namespace, f.path), type: f.type }));
  }
}
