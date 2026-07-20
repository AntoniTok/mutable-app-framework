import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { AppEgressPolicy, Env } from "../types";

/**
 * A MEDIATED outbound-fetch capability handed to an app by the broker
 * (`requestFetch`).
 *
 * The app sandbox itself has `globalOutbound: null` — it cannot open a socket.
 * This trusted entrypoint makes the request on the app's behalf, but ONLY to
 * hosts on the app's per-app allowlist (stored in trusted AppHost storage, not
 * settable by the app). Everything else is rejected. So an app can reach a
 * known API without ever being handed raw network access.
 *
 * Requests are buffered and returned as a plain, RPC-serializable result rather
 * than a streaming Response, so the boundary stays simple and predictable.
 */
export type ScopedFetcherProps = {
  instance: string;
};

/** What the app passes; a safe subset of RequestInit (all RPC-serializable). */
export interface ScopedFetchInit {
  method?: string;
  headers?: Record<string, string> | [string, string][];
  body?: string | ArrayBuffer | null;
}

/** The buffered result handed back to the app. */
export interface ScopedFetchResult {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
}

/** Does `host` match an allowlist entry (exact, or a `*.example.com` suffix)? */
function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allow) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

export class ScopedFetcher extends WorkerEntrypoint<Env, ScopedFetcherProps> {
  #host(): Promise<AppEgressPolicy> {
    return getAgentByName(
      this.env.AppHost,
      this.ctx.props.instance
    ) as unknown as Promise<AppEgressPolicy>;
  }

  /**
   * Fetch `url` if (and only if) its host is on this app's allowlist. Only
   * http(s) is permitted. Throws a clear error when the host isn't allowed, so a
   * buggy app fails loudly instead of silently reaching nowhere.
   *
   * Named `send` (not `fetch`) so it doesn't collide with the WorkerEntrypoint
   * HTTP entrypoint signature.
   */
  async send(url: string, init: ScopedFetchInit = {}): Promise<ScopedFetchResult> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error(`requestFetch: invalid URL "${url}".`);
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error(`requestFetch: only http(s) is allowed (got "${target.protocol}").`);
    }

    const allow = await (await this.#host()).getEgressAllowlist();
    if (!hostAllowed(target.host, allow)) {
      throw new Error(
        `requestFetch: host "${target.host}" is not on this app's egress allowlist. ` +
          `Add it via the room's egress settings first.`
      );
    }

    const headers = new Headers(init.headers as HeadersInit | undefined);
    const method = (init.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && init.body != null;

    const res = await fetch(target.toString(), {
      method,
      headers,
      body: hasBody ? (init.body as BodyInit) : undefined,
      redirect: "follow"
    });

    return {
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      body: await res.arrayBuffer()
    };
  }
}
