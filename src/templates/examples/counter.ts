import type { AppTemplate } from "../types";

/**
 * EXAMPLE APP — interactive counter page (non-realtime).
 *
 * This ships as an example to demonstrate the app contract. It is NOT part of
 * the framework core — delete it, edit it, or add your own alongside it in this
 * `examples/` folder and register it in ../registry.ts. To make it the hosted
 * app, set DEFAULT_TEMPLATE_ID = "counter" in ../registry.ts.
 *
 * This is a real, rendered web app — not a text API:
 *   - GET "/"      returns a full HTML page with a number display and buttons
 *   - GET "inc"    increments and returns JSON { count }
 *   - GET "dec"    decrements
 *   - GET "reset"  sets to 0
 *   - GET "count"  returns the current value
 *
 * The page's buttons call the data endpoints with RELATIVE urls, so they work
 * inside the preview (which mounts the app under /preview/ with an injected
 * <base href="/preview/">). It persists through the capability broker and makes
 * no network calls.
 *
 * Written as plain JavaScript (no backticks, to keep it easy to embed here) so
 * it needs no build step and doubles as a reference example for the AI author.
 */
const INDEX_JS = [
  "const PAGE = [",
  "  '<!DOCTYPE html><html><head><meta charset=\"utf-8\">',",
  "  '<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">',",
  "  '<style>',",
  "  'body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3}',",
  "  '.card{text-align:center;padding:40px 56px;border:1px solid #30363d;border-radius:16px;background:#161b22}',",
  "  '.count{font-size:72px;font-weight:700;margin:0 0 24px}',",
  "  'button{font-size:20px;padding:10px 18px;margin:0 6px;border:0;border-radius:10px;background:#2f81f7;color:#fff;cursor:pointer}',",
  "  'button.ghost{background:transparent;border:1px solid #30363d;color:#e6edf3}',",
  "  '</style></head><body>',",
  "  '<div class=\"card\">',",
  "  '<p class=\"count\" id=\"count\">__COUNT__</p>',",
  "  '<button onclick=\"call(\\'dec\\')\">-1</button>',",
  "  '<button onclick=\"call(\\'inc\\')\">+1</button>',",
  "  '<button class=\"ghost\" onclick=\"call(\\'reset\\')\">reset</button>',",
  "  '</div>',",
  "  '<script>',",
  "  'async function call(p){const r=await fetch(p);const d=await r.json();document.getElementById(\"count\").textContent=d.count;}',",
  "  '</' + 'script>',",
  "  '</body></html>'",
  "].join('');",
  "",
  "export default {",
  "  async fetch(request, env) {",
  "    const url = new URL(request.url);",
  "    const store = await env.SYSTEM.requestStore('counter');",
  "    const read = async () => Number((await store.get('count')) ?? '0');",
  "",
  "    if (url.pathname === '/inc') {",
  "      const n = (await read()) + 1; await store.put('count', String(n));",
  "      return Response.json({ count: n });",
  "    }",
  "    if (url.pathname === '/dec') {",
  "      const n = (await read()) - 1; await store.put('count', String(n));",
  "      return Response.json({ count: n });",
  "    }",
  "    if (url.pathname === '/reset') {",
  "      await store.put('count', '0'); return Response.json({ count: 0 });",
  "    }",
  "    if (url.pathname === '/count') {",
  "      return Response.json({ count: await read() });",
  "    }",
  "",
  "    const page = PAGE.replace('__COUNT__', String(await read()));",
  "    return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });",
  "  }",
  "};",
  ""
].join("\n");

export const counterTemplate: AppTemplate = {
  id: "counter",
  label: "Counter (interactive page)",
  declares: ["store"],
  entrypoint: "src/index.js",
  files: [{ path: "src/index.js", content: INDEX_JS }]
};
