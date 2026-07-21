import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { AppSecretsPolicy, Env } from "../types";

/**
 * A read-only view of the app's secrets, handed out by the broker
 * (`requestSecrets`).
 *
 * SECURITY MODEL (use-not-read): secrets are set by the USER via the room's
 * secret settings and stored in TRUSTED AppHost storage. The default posture is
 * that an app can USE a secret without ever READING it — e.g. by asking the
 * mediated fetcher to inject one into a request header (`ScopedFetcher.send`'s
 * `secretHeaders`), so the raw value never enters the sandbox.
 *
 * This capability is the OPT-IN escape hatch for the cases that genuinely need
 * the bytes (HMAC signing, custom auth schemes): `get(name)` returns the value
 * ONLY for a secret the user explicitly flagged `readable`; otherwise it throws.
 * `has`/`list` expose names only, never values.
 */
export type ScopedSecretsProps = {
  instance: string;
};

export class ScopedSecrets extends WorkerEntrypoint<Env, ScopedSecretsProps> {
  #host(): Promise<AppSecretsPolicy> {
    return getAgentByName(
      this.env.AppHost,
      this.ctx.props.instance
    ) as unknown as Promise<AppSecretsPolicy>;
  }

  /** The names of secrets configured for this app (no values). */
  async list(): Promise<string[]> {
    return (await (await this.#host()).listSecrets()).map((s) => s.name);
  }

  /** Whether a secret with this name exists (no value revealed). */
  async has(name: string): Promise<boolean> {
    return (await (await this.#host()).listSecrets()).some((s) => s.name === name);
  }

  /**
   * Read a secret's raw value. Works ONLY for secrets the user flagged
   * `readable`; otherwise throws (use `secretHeaders` on requestFetch instead).
   */
  async get(name: string): Promise<string> {
    return (await this.#host()).resolveSecret(name, { requireReadable: true });
  }
}
