import { WorkerEntrypoint } from "cloudflare:workers";
import type { AppSql } from "../agent/app-sql";
import type { Env, SqlParam, SqlResult } from "../types";

/**
 * A private relational SQL database handed to an app by the broker
 * (`requestSql`). Every operation runs against the per-room `AppSql` Durable
 * Object's OWN SQLite, reached DIRECTLY by this stub (2 hops, never through
 * AppHost — limitation #3). One app can never see another's database.
 *
 * Unlike `requestStore` (a flat string KV), this is a REAL SQL surface: define
 * your own tables and run arbitrary queries with bound parameters. Guardrails
 * (max rows per query, max DB size) are enforced inside AppSql against the app's
 * trusted limits. Use `?` placeholders + params — NEVER string-concatenate user
 * input into SQL.
 */
export type ScopedSqlProps = {
  instance: string;
};

export class ScopedSql extends WorkerEntrypoint<Env, ScopedSqlProps> {
  /** The exact AppSql DO this capability is scoped to (direct reach). */
  #db(): DurableObjectStub<AppSql> {
    const id = this.env.APP_SQL.idFromName(this.ctx.props.instance);
    return this.env.APP_SQL.get(id);
  }

  /**
   * Run one SQL statement with bound params and return the FULL result
   * (`{ rows, columnNames, rowsRead, rowsWritten, lastRowId }`). Use `?`
   * placeholders and pass values as params — e.g.
   * `exec("INSERT INTO todos (text, done) VALUES (?, ?)", text, false)`.
   */
  async exec(sql: string, ...params: SqlParam[]): Promise<SqlResult> {
    return this.#db().sqlExec(sql, params);
  }

  /**
   * Convenience for SELECTs: run the statement and return just the rows array
   * (typed). Equivalent to `(await exec(...)).rows`.
   */
  async query<T = Record<string, SqlStorageValue>>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    const result = await this.#db().sqlExec(sql, params);
    return result.rows as unknown as T[];
  }

  /** Run the statement and return the FIRST row, or null if there are none. */
  async first<T = Record<string, SqlStorageValue>>(sql: string, ...params: SqlParam[]): Promise<T | null> {
    const result = await this.#db().sqlExec(sql, params);
    return (result.rows[0] as unknown as T) ?? null;
  }

  /**
   * Run a write (INSERT/UPDATE/DELETE/DDL) and return just the accounting
   * (`{ rowsWritten, rowsRead, lastRowId }`) — the natural shape for mutations.
   */
  async run(
    sql: string,
    ...params: SqlParam[]
  ): Promise<{ rowsWritten: number; rowsRead: number; lastRowId: number | null }> {
    const { rowsWritten, rowsRead, lastRowId } = await this.#db().sqlExec(sql, params);
    return { rowsWritten, rowsRead, lastRowId };
  }
}
