import { getAgentByName, routeAgentRequest } from "agents";
import type { Env } from "./types";
import type { AppHost } from "./agent/app-host";
import { runApp } from "./agent/runner";
import { isKnownTemplate, listTemplates } from "./templates/registry";

// The Agent + capability entrypoints must be exported from the main module so
// the runtime can instantiate them (DO) and mint stubs (WorkerEntrypoint).
export { AppHost } from "./agent/app-host";
export { AppData } from "./agent/app-data";
export { AppScheduler } from "./agent/app-scheduler";
export { AppSql } from "./agent/app-sql";
export { CodeAssistant } from "./assistant/code-assistant";
export { CapabilityBroker } from "./capabilities/broker";
export { ScopedStore } from "./capabilities/scoped-store";
export { ScopedFilesystem } from "./capabilities/scoped-filesystem";
export { ScopedBlobStore } from "./capabilities/scoped-blob-store";
export { ScopedFetcher } from "./capabilities/scoped-fetcher";
export { ScopedSecrets } from "./capabilities/scoped-secrets";
export { ScopedEmail } from "./capabilities/scoped-email";
export { ScopedRoom } from "./capabilities/scoped-room";
export { ScopedScheduler } from "./capabilities/scoped-scheduler";
export { ScopedSql } from "./capabilities/scoped-sql";
// Tail Worker: captures logs/exceptions/outcome from the untrusted app's
// Dynamic Worker runs into Workers Logs (attached in src/agent/runner.ts).
export { DynamicWorkerTail } from "./observability/dynamic-worker-tail";

// Each room is its own isolated app instance (one Durable Object per id, with
// its own code + version history + realtime state). The room id is taken from
// the `?room=` query param; absent/invalid falls back to "main" (back-compat).
const DEFAULT_ROOM = "main";

/**
 * Resolve the target room from a request URL. The id becomes a Durable Object
 * name, so it's sanitized to a safe charset and length; anything else (or a
 * missing param) resolves to the default room.
 */
function roomOf(url: URL): string {
  const raw = url.searchParams.get("room");
  if (!raw) return DEFAULT_ROOM;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return cleaned || DEFAULT_ROOM;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data as Record<string, unknown>, { status });
}

function errorResponse(err: unknown, status = 500): Response {
  const message = err instanceof Error ? err.message : String(err);
  return json({ error: message }, status);
}

async function handleApi(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  // Static catalog for the lobby's template picker — no room / DO involved.
  if (path === "/api/templates" && request.method === "GET") {
    return json({ templates: listTemplates() });
  }

  const room = roomOf(new URL(request.url));
  const agent = await getAgentByName<Env, AppHost>(env.AppHost, room);

  try {
    // Create/seed a room from a chosen template (runtime template selection).
    // Idempotent: an existing room is returned unchanged (never re-seeded).
    if (path === "/api/create" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { template?: unknown };
      const template =
        typeof body.template === "string" && isKnownTemplate(body.template)
          ? body.template
          : undefined;
      const { state, created } = await agent.create(template);
      return json({ room, templateId: state.templateId, created });
    }
    if (path === "/api/state" && request.method === "GET") {
      return json(await agent.getStatus());
    }
    if (path === "/api/resources" && request.method === "GET") {
      return json(await agent.getResources());
    }
    if (path === "/api/files" && request.method === "GET") {
      return json({ files: await agent.getFiles() });
    }
    if (path === "/api/versions" && request.method === "GET") {
      return json({ versions: await agent.listVersions() });
    }
    if (path === "/api/files" && request.method === "POST") {
      const body = (await request.json()) as { files?: unknown; note?: string };
      if (!Array.isArray(body.files)) return errorResponse("files[] required", 400);
      const version = await agent.setFiles(body.files as never, body.note);
      return json({ version });
    }
    if (path === "/api/reset" && request.method === "POST") {
      const version = await agent.resetToTemplate();
      return json({ version });
    }
    if (path === "/api/rollback" && request.method === "POST") {
      const body = (await request.json()) as { version?: number };
      if (typeof body.version !== "number")
        return errorResponse("version (number) required", 400);
      await agent.rollback(body.version);
      return json({ ok: true });
    }
    if (path === "/api/egress" && request.method === "GET") {
      return json({ allow: await agent.getEgressAllowlist() });
    }
    if (path === "/api/egress" && request.method === "POST") {
      const body = (await request.json()) as { allow?: unknown };
      if (!Array.isArray(body.allow))
        return errorResponse("allow[] (string hostnames) required", 400);
      const allow = await agent.setEgressAllowlist(body.allow as string[]);
      return json({ allow });
    }
    if (path === "/api/limits" && request.method === "GET") {
      return json({ limits: await agent.getLimits() });
    }
    if (path === "/api/limits" && request.method === "POST") {
      const body = (await request.json()) as { limits?: unknown };
      if (typeof body.limits !== "object" || body.limits === null)
        return errorResponse("limits (object) required", 400);
      const limits = await agent.setLimits(body.limits as Record<string, number>);
      return json({ limits });
    }
    if (path === "/api/secrets" && request.method === "GET") {
      // Names + readable flags ONLY — values are never returned over the wire.
      return json({ secrets: await agent.listSecrets() });
    }
    if (path === "/api/secrets" && request.method === "POST") {
      const body = (await request.json()) as {
        name?: unknown;
        value?: unknown;
        readable?: unknown;
        delete?: unknown;
      };
      if (typeof body.name !== "string" || body.name.length === 0)
        return errorResponse("name (string) required", 400);
      if (body.delete === true || body.value === null || body.value === undefined) {
        await agent.deleteSecret(body.name);
        return json({ ok: true, deleted: body.name });
      }
      const info = await agent.setSecret(
        body.name,
        String(body.value),
        body.readable === true
      );
      return json({ secret: info });
    }
    if (path === "/api/email" && request.method === "GET") {
      return json({ policy: await agent.getEmailPolicy() });
    }
    if (path === "/api/email" && request.method === "POST") {
      const body = (await request.json()) as { policy?: unknown };
      if (typeof body.policy !== "object" || body.policy === null)
        return errorResponse("policy (object) required", 400);
      const policy = await agent.setEmailPolicy(body.policy as Record<string, unknown>);
      return json({ policy });
    }
    return errorResponse("Not found", 404);
  } catch (err) {
    return errorResponse(err);
  }
}

async function handlePreview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Strip the "/preview" prefix so the app sees its own path (e.g. "/inc").
  const appPath = url.pathname.replace(/^\/preview/, "") || "/";
  const appUrl = new URL(request.url);
  appUrl.pathname = appPath;

  const room = roomOf(url);
  const agent = await getAgentByName<Env, AppHost>(env.AppHost, room);
  try {
    // Fetch only the CODE from the DO, then run the app HERE in the host worker.
    // Running out-of-DO lets us STREAM the app's response straight to the client
    // (SSE, large bodies) instead of buffering it through an RPC ArrayBuffer, and
    // keeps the app's HTTP data path off the single-threaded DO. Storage
    // capabilities call straight into the app's own AppData DO, mediated by the
    // broker — never back through AppHost (limitation #3).
    const manifest = await agent.getRunManifest();
    if (manifest.files.length === 0) {
      return new Response("No app code yet.", {
        status: 503,
        headers: { "content-type": "text/plain" }
      });
    }

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const appRequest = new Request(appUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body : undefined,
      // Required when forwarding a streaming request body in Workers.
      ...(hasBody ? { duplex: "half" } : {})
    } as RequestInit);

    const { response } = await runApp({
      env,
      instance: room,
      version: manifest.version,
      files: manifest.files,
      entrypoint: manifest.entrypoint,
      request: appRequest,
      // Cold-cache only: reuse the build persisted on promote (limitation #4).
      resolvePrebuilt: (hash) => agent.getBuild(hash),
      // Per-run guardrails (limitation #5): generous, per-app configurable.
      limits: manifest.limits
    });

    const contentType = response.headers.get("content-type") ?? "";
    const headers = new Headers(response.headers);
    // content-length would be wrong once we rewrite HTML; let the runtime set it.
    headers.delete("content-length");

    // text/html: inject <base href="/preview/"> so the app's relative links and
    // fetches resolve under the preview prefix — STREAMING, via HTMLRewriter, so
    // we never buffer the page. Everything else streams through untouched.
    if (contentType.includes("text/html")) {
      headers.delete("content-encoding");
      const rewritten = new HTMLRewriter()
        .on("head", {
          element(el) {
            el.prepend('<base href="/preview/">', { html: true });
          }
        })
        .transform(new Response(response.body, { status: response.status, headers }));
      return rewritten;
    }

    return new Response(response.body, { status: response.status, headers });
  } catch (err) {
    return errorResponse(err);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) return handleApi(request, env, path);
    if (path === "/preview" || path.startsWith("/preview/"))
      return handlePreview(request, env);
    if (path.startsWith("/agents/"))
      return (
        (await routeAgentRequest(request, env)) ||
        new Response("Not found", { status: 404 })
      );

    // Static assets (the editor UI) are served by the assets binding.
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
