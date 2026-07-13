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
}
