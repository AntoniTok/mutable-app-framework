import type { AppFile } from "../templates/types";

/**
 * Database shape for one app (one AppHost instance).
 *
 * Three tables live in the Agent's own SQLite:
 *   - files:    the source code, one row per file per version
 *   - versions: the history list (enables rollback)
 *   - app_data: ONLY the realtime engine's `__room__` state (the coordinator's
 *               own state). The app's OWN key/value + filesystem data now lives
 *               in the AppStorageFacet's isolated SQLite, not here.
 *
 * Keeping the SQL in one place lets the Agent read like intentions
 * ("save a version", "get live files") instead of raw queries.
 */

// `this.sql` is a tagged-template function on the Agent. We accept a minimal
// structural type so these helpers don't depend on the full Agent generics.
interface SqlAgent {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

export function createTables(agent: SqlAgent): void {
  agent.sql`CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  )`;
  agent.sql`CREATE TABLE IF NOT EXISTS files (
    version INTEGER NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (version, path)
  )`;
  agent.sql`CREATE TABLE IF NOT EXISTS app_data (
    scope TEXT NOT NULL,
    k TEXT NOT NULL,
    v TEXT NOT NULL,
    PRIMARY KEY (scope, k)
  )`;
  // Precompiled build cache (limitation #4): the bundler output for a given
  // file-content hash, captured on promote so the request path never re-runs
  // esbuild on a cold Worker Loader cache. `modules` is a JSON object of
  // path -> source. Keyed by hash (not version) since identical code shares one.
  agent.sql`CREATE TABLE IF NOT EXISTS builds (
    hash TEXT PRIMARY KEY,
    main TEXT NOT NULL,
    modules TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`;
}

export interface StoredBuild {
  mainModule: string;
  modules: Record<string, string>;
}

/** Fetch a persisted build by content hash, or undefined if none is stored. */
export function getBuild(agent: SqlAgent, hash: string): StoredBuild | undefined {
  const [row] = agent.sql<{ main: string; modules: string }>`
    SELECT main, modules FROM builds WHERE hash = ${hash}`;
  if (!row) return undefined;
  return {
    mainModule: row.main,
    modules: JSON.parse(row.modules) as Record<string, string>
  };
}

/** Persist a build for a content hash (idempotent; overwrites on conflict). */
export function putBuild(
  agent: SqlAgent,
  hash: string,
  mainModule: string,
  modules: Record<string, string>
): void {
  agent.sql`INSERT INTO builds (hash, main, modules, ts)
    VALUES (${hash}, ${mainModule}, ${JSON.stringify(modules)}, ${Date.now()})
    ON CONFLICT (hash) DO UPDATE SET main = excluded.main, modules = excluded.modules, ts = excluded.ts`;
}

/** Prune old builds so the cache can't grow without bound. Keeps the newest `keep`. */
export function pruneBuilds(agent: SqlAgent, keep: number): number {
  const recent = agent.sql<{ hash: string }>`
    SELECT hash FROM builds ORDER BY ts DESC LIMIT ${Math.max(1, keep)}`;
  const keepHashes = new Set<string>(recent.map((r) => r.hash));
  const all = agent.sql<{ hash: string }>`SELECT hash FROM builds`;
  const doomed = all.map((r) => r.hash).filter((h) => !keepHashes.has(h));
  for (const h of doomed) {
    agent.sql`DELETE FROM builds WHERE hash = ${h}`;
  }
  return doomed.length;
}

/** Insert a new version + its files. Returns the new version id. */
export function insertVersion(
  agent: SqlAgent,
  files: AppFile[],
  note: string
): number {
  const [row] = agent.sql<{ id: number }>`
    INSERT INTO versions (ts, note) VALUES (${Date.now()}, ${note})
    RETURNING id`;
  const version = row.id;
  for (const f of files) {
    agent.sql`INSERT INTO files (version, path, content)
      VALUES (${version}, ${f.path}, ${f.content})`;
  }
  return version;
}

export function getFiles(agent: SqlAgent, version: number): AppFile[] {
  return agent.sql<AppFile>`
    SELECT path, content FROM files WHERE version = ${version} ORDER BY path`;
}

export function versionExists(agent: SqlAgent, version: number): boolean {
  const [row] = agent.sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM versions WHERE id = ${version}`;
  return row.n > 0;
}

export function hasAnyVersion(agent: SqlAgent): boolean {
  const [row] = agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM versions`;
  return row.n > 0;
}

export interface VersionRow {
  id: number;
  ts: number;
  note: string;
}

export function listVersions(agent: SqlAgent): VersionRow[] {
  return agent.sql<VersionRow>`
    SELECT id, ts, note FROM versions ORDER BY id DESC`;
}

/**
 * Prune old versions so history can't grow without bound (every AI/manual edit
 * inserts a version + its file rows, forever). Keeps the newest `keep` versions
 * PLUS the currently-active one (which may be older than the newest `keep` after
 * a rollback), and deletes the rest along with their `files` rows.
 *
 * Tradeoff: rollback can only reach a version that still exists, so `keep` is the
 * effective depth of the undo history. Returns how many versions were removed.
 */
export function pruneVersions(
  agent: SqlAgent,
  keep: number,
  activeVersion: number
): number {
  const recent = agent.sql<{ id: number }>`
    SELECT id FROM versions ORDER BY id DESC LIMIT ${Math.max(1, keep)}`;
  const keepIds = new Set<number>(recent.map((r) => r.id));
  keepIds.add(activeVersion);

  const all = agent.sql<{ id: number }>`SELECT id FROM versions`;
  const doomed = all.map((r) => r.id).filter((id) => !keepIds.has(id));
  for (const id of doomed) {
    agent.sql`DELETE FROM files WHERE version = ${id}`;
    agent.sql`DELETE FROM versions WHERE id = ${id}`;
  }
  return doomed.length;
}

// ── app_data (now only the realtime coordinator's __room__ state; the app's
//    own store/filesystem moved to the AppStorageFacet) ──

export function appDataGet(
  agent: SqlAgent,
  scope: string,
  key: string
): string | null {
  const [row] = agent.sql<{ v: string }>`
    SELECT v FROM app_data WHERE scope = ${scope} AND k = ${key}`;
  return row ? row.v : null;
}

export function appDataPut(
  agent: SqlAgent,
  scope: string,
  key: string,
  value: string
): void {
  agent.sql`INSERT INTO app_data (scope, k, v) VALUES (${scope}, ${key}, ${value})
    ON CONFLICT (scope, k) DO UPDATE SET v = excluded.v`;
}

export function appDataDelete(
  agent: SqlAgent,
  scope: string,
  key: string
): void {
  agent.sql`DELETE FROM app_data WHERE scope = ${scope} AND k = ${key}`;
}

export function appDataList(agent: SqlAgent, scope: string): string[] {
  const rows = agent.sql<{ k: string }>`
    SELECT k FROM app_data WHERE scope = ${scope} ORDER BY k`;
  return rows.map((r) => r.k);
}
