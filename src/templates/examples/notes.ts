import type { AppTemplate } from "../types";

/**
 * EXAMPLE APP — a notes pad backed by the FILESYSTEM capability (non-realtime).
 *
 * This is the counterpart to counter.ts: where counter.ts demonstrates the flat
 * key/value store (`env.SYSTEM.requestStore`), this app demonstrates the
 * filesystem capability (`env.SYSTEM.requestFilesystem`) — folders, listing,
 * reading/writing/removing files. It exists to show the fs contract; it is NOT
 * part of the framework core. Delete it, edit it, or add your own alongside it
 * and register it in ../registry.ts. Once registered it appears in the lobby's
 * app picker; create a room with it (or set DEFAULT_TEMPLATE_ID = "notes" in
 * ../registry.ts to make it the fallback).
 *
 * Each note is one file under "notes/<name>.txt". The app never sees a raw
 * filesystem — the broker hands it a namespace-scoped capability, and paths are
 * relative (no leading "/", no ".."). Missing files read back as null.
 *
 * This is a real, rendered web app — not a text API:
 *   - GET  "/"        full HTML page: a list of notes + a form to add one
 *   - GET  "list"     returns JSON { notes: [{ name, size }] }
 *   - GET  "read?name=x"   returns JSON { name, text } (text null if missing)
 *   - POST "save"     body { name, text } → writes notes/<name>.txt
 *   - POST "remove"   body { name } → deletes notes/<name>.txt
 *
 * Buttons/forms call the data endpoints with RELATIVE urls so they work inside
 * the preview. Persists only through the capability broker; no network calls.
 *
 * The page uses single-quoted strings (no inner backticks) only so this app
 * source embeds cleanly in THIS TypeScript file — not a runtime requirement.
 * Runtime code is bundled by esbuild, so template literals work fine there and
 * are the preferred style (see src/assistant/code-assistant.ts).
 */
const INDEX_JS = [
  "const PAGE = [",
  "  '<!DOCTYPE html><html><head><meta charset=\"utf-8\">',",
  "  '<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">',",
  "  '<style>',",
  "  'body{margin:0;min-height:100vh;font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center}',",
  "  '.wrap{width:100%;max-width:640px;padding:32px 20px}',",
  "  'h1{font-size:24px;margin:0 0 20px}',",
  "  'input,textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px;margin:0 0 10px;border:1px solid #30363d;border-radius:8px;background:#0d1117;color:#e6edf3}',",
  "  'textarea{min-height:80px;resize:vertical}',",
  "  'button{font-size:15px;padding:8px 14px;border:0;border-radius:8px;background:#2f81f7;color:#fff;cursor:pointer}',",
  "  'button.ghost{background:transparent;border:1px solid #30363d;color:#e6edf3}',",
  "  '.note{border:1px solid #30363d;border-radius:10px;background:#161b22;padding:14px 16px;margin:0 0 10px}',",
  "  '.note h3{margin:0 0 6px;font-size:16px}',",
  "  '.note pre{margin:0 0 10px;white-space:pre-wrap;word-break:break-word;color:#9da7b3}',",
  "  '.muted{color:#6e7681}',",
  "  '</style></head><body><div class=\"wrap\">',",
  "  '<h1>Notes</h1>',",
  "  '<input id=\"name\" placeholder=\"note name (e.g. todo)\">',",
  "  '<textarea id=\"text\" placeholder=\"write something...\"></textarea>',",
  "  '<button onclick=\"save()\">Save note</button>',",
  "  '<div id=\"list\" style=\"margin-top:24px\"></div>',",
  "  '<script>',",
  "  'function elem(tag, cls, text){ var e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }',",
  "  'async function refresh(){',",
  "  '  const d = await (await fetch(\"list\")).json();',",
  "  '  const el = document.getElementById(\"list\");',",
  "  '  el.textContent = \"\";',",
  "  '  if(!d.notes.length){ el.appendChild(elem(\"p\", \"muted\", \"No notes yet.\")); return; }',",
  "  '  d.notes.forEach(function(n){',",
  "  '    var box = elem(\"div\", \"note\");',",
  "  '    box.appendChild(elem(\"h3\", null, n.name));',",
  "  '    box.appendChild(elem(\"pre\", null, n.text));',",
  "  '    var eb = elem(\"button\", \"ghost\", \"edit\"); eb.onclick = function(){ edit(n.name); }; box.appendChild(eb);',",
  "  '    var db = elem(\"button\", \"ghost\", \"delete\"); db.onclick = function(){ remove(n.name); }; box.appendChild(db);',",
  "  '    el.appendChild(box);',",
  "  '  });',",
  "  '}',",
  "  'async function save(){',",
  "  '  const name=document.getElementById(\"name\").value.trim();',",
  "  '  const text=document.getElementById(\"text\").value;',",
  "  '  if(!name)return;',",
  "  '  await fetch(\"save\",{method:\"POST\",headers:{\"content-type\":\"application/json\"},body:JSON.stringify({name:name,text:text})});',",
  "  '  document.getElementById(\"name\").value=\"\";document.getElementById(\"text\").value=\"\";refresh();',",
  "  '}',",
  "  'function edit(name){',",
  "  '  fetch(\"read?name=\"+encodeURIComponent(name)).then(function(r){return r.json();}).then(function(d){',",
  "  '    document.getElementById(\"name\").value=d.name;document.getElementById(\"text\").value=d.text||\"\";',",
  "  '  });',",
  "  '}',",
  "  'async function remove(name){',",
  "  '  await fetch(\"remove\",{method:\"POST\",headers:{\"content-type\":\"application/json\"},body:JSON.stringify({name:name})});refresh();',",
  "  '}',",
  "  'refresh();',",
  "  '</' + 'script>',",
  "  '</div></body></html>'",
  "].join('');",
  "",
  "// Note name -> safe relative path. Keep names simple; the trusted capability",
  "// still rejects traversal, but we constrain here too.",
  "function pathFor(name) {",
  "  const clean = String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);",
  "  return 'notes/' + clean + '.txt';",
  "}",
  "",
  "export default {",
  "  async fetch(request, env) {",
  "    const url = new URL(request.url);",
  "    const fs = await env.SYSTEM.requestFilesystem('notes');",
  "",
  "    if (url.pathname === '/list') {",
  "      const entries = (await fs.readdir('notes')) || [];",
  "      const notes = [];",
  "      for (const e of entries) {",
  "        if (e.type !== 'file' || !e.name.endsWith('.txt')) continue;",
  "        const name = e.name.slice(0, -4);",
  "        const text = (await fs.readFile('notes/' + e.name)) || '';",
  "        notes.push({ name, text });",
  "      }",
  "      notes.sort((a, b) => a.name.localeCompare(b.name));",
  "      return Response.json({ notes });",
  "    }",
  "",
  "    if (url.pathname === '/read') {",
  "      const name = url.searchParams.get('name') || '';",
  "      const text = await fs.readFile(pathFor(name));",
  "      return Response.json({ name, text });",
  "    }",
  "",
  "    if (url.pathname === '/save' && request.method === 'POST') {",
  "      const body = await request.json();",
  "      if (!body || !body.name) return Response.json({ ok: false }, { status: 400 });",
  "      await fs.writeFile(pathFor(body.name), String(body.text || ''));",
  "      return Response.json({ ok: true });",
  "    }",
  "",
  "    if (url.pathname === '/remove' && request.method === 'POST') {",
  "      const body = await request.json();",
  "      if (!body || !body.name) return Response.json({ ok: false }, { status: 400 });",
  "      await fs.rm(pathFor(body.name), { recursive: false });",
  "      return Response.json({ ok: true });",
  "    }",
  "",
  "    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });",
  "  }",
  "};",
  ""
].join("\n");

export const notesTemplate: AppTemplate = {
  id: "notes",
  label: "Notes (filesystem-backed page)",
  declares: ["fs"],
  entrypoint: "src/index.js",
  files: [{ path: "src/index.js", content: INDEX_JS }]
};
