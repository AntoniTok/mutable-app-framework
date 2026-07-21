import { DurableObject } from "cloudflare:workers";
import { DEFAULT_LIMITS } from "../config/limits";
import type { AppSqlStore, Env, SqlParam, SqlResult } from "../types";

/**
 * AppSql — the app's isolated RELATIONAL database (broker.requestSql).
 *
 * A Durable Object keyed by the app instance (room id), backed by its OWN SQLite
 * (`ctx.storage.sql`), separate from AppHost's code store and from AppData's
 * key/value + filesystem. Where `requestStore` is a flat string KV, this is a
 * REAL SQL surface: the app defines its own tables and runs arbitrary
 * queries — leaderboards, relational data, aggregation, joins.
 *
 * HOW IT'S REACHED (limitation #3 — 2 hops, no funneling): the untrusted app
 * asks the broker (`env.SYSTEM.requestSql`), which hands back a `ScopedSql` stub;
 * that stub talks to THIS DO DIRECTLY by name
 * (`env.APP_SQL.idFromName(instance)`), so SQL traffic never passes through
 * AppHost. The DO adds isolation; the stub carries no policy beyond forwarding —
 * the guardrails (row cap, DB-size cap) are enforced HERE, against caps pushed
 * from AppHost's trusted limits.
 *
 * TRUST NOTE: tenants are trusted-ish, so an app may run arbitrary SQL against
 * its OWN database (including DDL). The platform already blocks writes to
 * SQLite/Cloudflare-internal tables; we do NOT additionally parse or restrict
 * table names. Isolation between apps is by DO, not by SQL.
 */

const META_TABLE = "__appsql_meta__";

/** True if a statement can GROW the database (so it's blocked once at the cap). */
function isGrowthWrite(sql: string): boolean {
  const head = sql.replace(/^[\s;(]+/, "").slice(0, 12).toUpperCase();
  return (
    head.startsWith("INSERT") ||
    head.startsWith("UPDATE") ||
    head.startsWith("CREATE") ||
    head.startsWith("ALTER") ||
    head.startsWith("REPLACE")
  );
}

export class AppSql extends DurableObject<Env> implements AppSqlStore {
  // Guardrails (limitation #5). Generous defaults; the resolved values are pushed
  // from AppHost.setLimits (trusted policy) and persisted so they survive restart.
  #maxRows = DEFAULT_LIMITS.sqlMaxRows;
  #maxDbBytes = DEFAULT_LIMITS.sqlMaxDbBytes;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Our own tiny metadata table (double-underscored so it never collides with
    // an app table created via NAME rules). Holds the pushed caps.
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`
    );
    const rows = ctx.storage.sql
      .exec<{ v: string }>(`SELECT v FROM ${META_TABLE} WHERE k = 'limits'`)
      .toArray();
    if (rows.length) {
      try {
        const parsed = JSON.parse(rows[0].v) as { maxRows?: number; maxDbBytes?: number };
        if (typeof parsed.maxRows === "number") this.#maxRows = parsed.maxRows;
        if (typeof parsed.maxDbBytes === "number") this.#maxDbBytes = parsed.maxDbBytes;
      } catch {
        // keep defaults
      }
    }
  }

  /** Push the resolved SQL caps down from AppHost (trusted). Persisted. */
  async setSqlLimits(limits: { maxRows: number; maxDbBytes: number }): Promise<void> {
    if (typeof limits.maxRows === "number") this.#maxRows = limits.maxRows;
    if (typeof limits.maxDbBytes === "number") this.#maxDbBytes = limits.maxDbBytes;
    this.ctx.storage.sql.exec(
      `INSERT INTO ${META_TABLE} (k, v) VALUES ('limits', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      JSON.stringify({ maxRows: this.#maxRows, maxDbBytes: this.#maxDbBytes })
    );
  }

  /**
   * Run one SQL statement with bound params against the app's database. Enforces
   * the DB-size soft cap (blocks growth writes once at the cap; reads/deletes/
   * drops stay allowed so the app can recover) and the per-query row cap.
   */
  async sqlExec(sql: string, params: SqlParam[]): Promise<SqlResult> {
    if (typeof sql !== "string" || sql.trim().length === 0) {
      throw new Error("requestSql: a non-empty SQL string is required.");
    }
    if (isGrowthWrite(sql) && this.ctx.storage.sql.databaseSize >= this.#maxDbBytes) {
      throw new Error(
        `SQL database is full (${this.ctx.storage.sql.databaseSize} bytes, max ` +
          `${this.#maxDbBytes}). Delete rows or raise the limit in the room's resource settings.`
      );
    }

    const bindings = (Array.isArray(params) ? params : []).map((p) =>
      typeof p === "boolean" ? (p ? 1 : 0) : p
    );

    const cursor = this.ctx.storage.sql.exec(sql, ...bindings);
    const rows = cursor.toArray() as Record<string, SqlStorageValue>[];
    // Enforce the row cap AFTER materialising (SQLite streamed them cheaply); a
    // clear error is better than silently truncating a result set.
    if (rows.length > this.#maxRows) {
      throw new Error(
        `Query returned ${rows.length} rows (max ${this.#maxRows}). Add a LIMIT ` +
          "clause or raise the limit in the room's resource settings."
      );
    }
    const columnNames = cursor.columnNames;
    const rowsRead = cursor.rowsRead;
    const rowsWritten = cursor.rowsWritten;

    // last_insert_rowid() is only meaningful after a write; skip it for reads.
    let lastRowId: number | null = null;
    if (rowsWritten > 0) {
      const idRow = this.ctx.storage.sql
        .exec<{ id: number }>("SELECT last_insert_rowid() AS id")
        .toArray()[0];
      lastRowId = idRow ? Number(idRow.id) : null;
    }

    return { rows, columnNames, rowsRead, rowsWritten, lastRowId };
  }
}
