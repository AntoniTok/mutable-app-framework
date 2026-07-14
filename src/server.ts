import { getAgentByName, routeAgentRequest } from "agents";
import type { Env } from "./types";
import type { AppHost } from "./agent/app-host";

// The Agent + capability entrypoints must be exported from the main module so
// the runtime can instantiate them (DO) and mint stubs (WorkerEntrypoint).
export { AppHost } from "./agent/app-host";
export { CapabilityBroker } from "./capabilities/broker";
export { ScopedStore } from "./capabilities/scoped-store";
export { ScopedFilesystem } from "./capabilities/scoped-filesystem";

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
  const room = roomOf(new URL(request.url));
  const agent = await getAgentByName<Env, AppHost>(env.AppHost, room);

  try {
    if (path === "/api/state" && request.method === "GET") {
      return json(await agent.getStatus());
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
    if (path === "/api/edit" && request.method === "POST") {
      const body = (await request.json()) as { instruction?: string };
      if (!body.instruction) return errorResponse("instruction required", 400);
      const version = await agent.editWithAI(body.instruction);
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

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const agent = await getAgentByName<Env, AppHost>(env.AppHost, roomOf(url));
  try {
    const result = await agent.preview({
      url: appUrl.toString(),
      method: request.method,
      headers: [...request.headers.entries()],
      body: hasBody ? await request.text() : null
    });

    const contentType =
      result.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";

    // The app's response headers are forwarded, but two must never be copied
    // verbatim: content-length would be wrong the moment we touch the body, and
    // content-encoding would mislabel a body we've decoded. Strip both and let
    // the runtime recompute an accurate content-length.
    let bodyRewritten = false;
    let body: BodyInit = result.body;

    // Only text/html is decoded and rewritten; everything else (JSON, images,
    // downloads, ...) passes through as raw bytes, uncorrupted.
    if (contentType.includes("text/html")) {
      let html = new TextDecoder().decode(result.body);
      // Inject <base href="/preview/"> so the app's relative links/fetches
      // resolve back under the preview prefix (so in-page buttons work).
      if (!/<base\s/i.test(html)) {
        const baseTag = '<base href="/preview/">';
        html = /<head[^>]*>/i.test(html)
          ? html.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`)
          : `${baseTag}${html}`;
      }
      body = html;
      bodyRewritten = true;
    }

    const headers = new Headers(result.headers);
    headers.delete("content-length");
    if (bodyRewritten) headers.delete("content-encoding");

    return new Response(body, {
      status: result.status,
      headers
    });
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
