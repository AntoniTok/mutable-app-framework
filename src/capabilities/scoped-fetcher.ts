import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { AppEgressPolicy, AppSecretsPolicy, Env } from "../types";

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

/** How to inject a secret into a request header without the app reading it. */
export interface SecretHeaderInject {
  /** The configured secret NAME (set by the user in the room's secret settings). */
  secret: string;
  /** Optional literal prefix, e.g. "Bearer " for an Authorization header. */
  prefix?: string;
}

/** What the app passes; a safe subset of RequestInit (all RPC-serializable). */
export interface ScopedFetchInit {
  method?: string;
  headers?: Record<string, string> | [string, string][];
  body?: string | ArrayBuffer | null;
  /**
   * Inject secrets into request headers WITHOUT the app ever reading their
   * values (use-not-read). Map of header name -> secret name (string shorthand)
   * or `{ secret, prefix }`. Resolved host-side; applied on the FIRST hop only
   * and stripped on any redirect, so credentials never leak to a redirected host.
   */
  secretHeaders?: Record<string, string | SecretHeaderInject>;
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
  #host(): Promise<AppEgressPolicy & AppSecretsPolicy> {
    return getAgentByName(
      this.env.AppHost,
      this.ctx.props.instance
    ) as unknown as Promise<AppEgressPolicy & AppSecretsPolicy>;
  }

  /**
   * Fetch `url` if (and only if) its host is on this app's allowlist. Only
   * http(s) is permitted. Throws a clear error when the host isn't allowed, so a
   * buggy app fails loudly instead of silently reaching nowhere.
   *
   * SECURITY (SSRF): redirects are followed MANUALLY so EVERY hop is re-checked
   * against the allowlist. `redirect: "follow"` would let an allowlisted host
   * 302 to an internal address (e.g. cloud metadata) and be followed blindly —
   * so we resolve each `Location` ourselves and re-validate the host.
   *
   * GUARDRAILS: the request is aborted after `fetchTimeoutMs` and the response
   * body is capped at `fetchMaxBytes` (both per-app configurable). Redirect hops
   * are capped at `fetchMaxRedirects`.
   *
   * Named `send` (not `fetch`) so it doesn't collide with the WorkerEntrypoint
   * HTTP entrypoint signature.
   */
  async send(url: string, init: ScopedFetchInit = {}): Promise<ScopedFetchResult> {
    const host = await this.#host();
    const [allow, limits] = await Promise.all([
      host.getEgressAllowlist(),
      host.getLimits()
    ]);

    const requireAllowed = (target: URL, context: string): void => {
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        throw new Error(
          `requestFetch: only http(s) is allowed (got "${target.protocol}"${context}).`
        );
      }
      if (!hostAllowed(target.host, allow)) {
        throw new Error(
          `requestFetch: host "${target.host}" is not on this app's egress allowlist${context}. ` +
            `Add it via the room's egress settings first.`
        );
      }
    };

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error(`requestFetch: invalid URL "${url}".`);
    }
    requireAllowed(target, "");

    const method = (init.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && init.body != null;
    const baseHeaders = new Headers(init.headers as HeadersInit | undefined);

    // Resolve secret headers host-side (use-not-read): the raw values are set on
    // the outbound request but never returned to the app. Applied on the first
    // hop only; the header NAMES are recorded so we can strip them on a redirect,
    // so credentials never follow to a different (even if allowlisted) host.
    const secretHeaderNames: string[] = [];
    if (init.secretHeaders && typeof init.secretHeaders === "object") {
      for (const [headerName, spec] of Object.entries(init.secretHeaders)) {
        const ref: SecretHeaderInject = typeof spec === "string" ? { secret: spec } : spec;
        const value = await host.resolveSecret(ref.secret);
        baseHeaders.set(headerName, `${ref.prefix ?? ""}${value}`);
        secretHeaderNames.push(headerName);
      }
    }

    // Bound the whole operation (all hops) with one timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.fetchTimeoutMs);
    try {
      let res: Response;
      let hop = 0;
      // Manual redirect loop: re-validate every Location host.
      for (;;) {
        res = await fetch(target.toString(), {
          method,
          headers: baseHeaders,
          // Only the first hop carries a body; a redirected request drops it
          // (matching browser/2xx-3xx semantics for cross-origin redirects).
          body: hop === 0 && hasBody ? (init.body as BodyInit) : undefined,
          redirect: "manual",
          signal: controller.signal
        });

        const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
        if (!isRedirect) break;

        if (hop >= limits.fetchMaxRedirects) {
          throw new Error(
            `requestFetch: too many redirects (>${limits.fetchMaxRedirects}).`
          );
        }
        const location = res.headers.get("location") as string;
        let next: URL;
        try {
          next = new URL(location, target); // resolve relative Location
        } catch {
          throw new Error(`requestFetch: invalid redirect target "${location}".`);
        }
        requireAllowed(next, ` (via redirect from "${target.host}")`);
        // Drop injected credentials before following the redirect — don't leak
        // them to the next host even if it's allowlisted.
        for (const name of secretHeaderNames) baseHeaders.delete(name);
        target = next;
        hop++;
      }

      const body = await this.#readCapped(res, limits.fetchMaxBytes);
      return {
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()],
        body
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`requestFetch: request timed out after ${limits.fetchTimeoutMs}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read a response body but stop (and throw) once it exceeds `maxBytes`, so a
   * hostile/buggy endpoint can't stream an unbounded body into memory. Falls
   * back to a plain buffered read (still length-checked) if the body isn't a
   * readable stream.
   */
  async #readCapped(res: Response, maxBytes: number): Promise<ArrayBuffer> {
    const reader = res.body?.getReader();
    if (!reader) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) {
        throw new Error(`requestFetch: response too large (>${maxBytes} bytes).`);
      }
      return buf;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`requestFetch: response too large (>${maxBytes} bytes).`);
        }
        chunks.push(value);
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out.buffer;
  }
}
