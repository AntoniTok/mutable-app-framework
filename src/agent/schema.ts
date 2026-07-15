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
