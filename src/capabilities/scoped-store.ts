import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { AppDataStore, Env } from "../types";

/**
 * A private key/value store handed to an app by the broker.
 *
 * This is a capability: the app can only reach it because it was given the
 * stub. Every operation is scoped by `props.instance` (which app) and
 * `props.namespace` (which drawer within that app), so one app can never see
 * another's data.
 *
 * Backed by the AppHost's own SQLite `app_data` table — no external resource.
 */
export type ScopedStoreProps = {
  instance: string;
  namespace: string;
};

export class ScopedStore extends WorkerEntrypoint<Env, ScopedStoreProps> {
  #host(): Promise<AppDataStore> {
    // Reach the exact AppHost instance this capability was scoped to.
    return getAgentByName(
      this.env.AppHost,
      this.ctx.props.instance
    ) as unknown as Promise<AppDataStore>;
  }

  async get(key: string): Promise<string | null> {
    const host = await this.#host();
    return host.storeGet(this.ctx.props.namespace, key);
  }

  async put(key: string, value: string): Promise<void> {
    const host = await this.#host();
    // Basic guardrails live here in the trusted host, not in the app.
    if (typeof value !== "string") value = String(value);
    if (value.length > 1_000_000) {
      throw new Error("Value too large (max 1MB).");
    }
    await host.storePut(this.ctx.props.namespace, key, value);
  }

  async delete(key: string): Promise<void> {
    const host = await this.#host();
    await host.storeDelete(this.ctx.props.namespace, key);
  }

  async list(): Promise<string[]> {
    const host = await this.#host();
    return host.storeList(this.ctx.props.namespace);
  }

  /**
   * Atomically add `delta` (default 1) to a numeric value and return the new
   * total. Safe under concurrent requests — unlike a get()+put() pair, which can
   * lose updates because the input gate releases between them. Use this for
   * counters, tallies, and any single-key increment.
   */
  async incr(key: string, delta = 1): Promise<number> {
    if (typeof delta !== "number" || !Number.isFinite(delta)) {
      throw new Error("incr delta must be a finite number.");
    }
    const host = await this.#host();
    return host.storeIncr(this.ctx.props.namespace, key, delta);
  }

  /**
   * Atomic compare-and-swap: set `key` to `next` only if its current value is
   * exactly `expected` (`null` = the key must not exist). Returns whether the
   * write happened — retry on false to build a safe read-modify-write loop.
   */
  async cas(key: string, expected: string | null, next: string): Promise<boolean> {
    if (typeof next !== "string") next = String(next);
    const host = await this.#host();
    return host.storeCas(this.ctx.props.namespace, key, expected, next);
  }

  /**
   * Convenience wrappers for structured values: store any JSON-serializable
   * value and read it back typed. Backed by the same string store (values still
   * count against the 1 MB per-value cap after serialization).
   */
  async putJSON(key: string, value: unknown): Promise<void> {
    await this.put(key, JSON.stringify(value));
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }
}
