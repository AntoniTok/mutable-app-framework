import type { AppFile } from "../templates/types";
import type { CodeAuthor } from "./types";

/**
 * One implementation of CodeAuthor using Workers AI.
 *
 * Runs inside the host (the Agent), so the model binding/key never reaches the
 * untrusted app. Swap in an OpenAI/Anthropic version later by writing another
 * class that implements CodeAuthor — nothing else changes.
 */

// Default author model. Precise, line-addressed editing needs a model that can
// reliably read line numbers off the numbered file we show it and emit exact
// positions. gpt-oss-120b does this cleanly (small, correct edits in ~2-4s);
// weaker instruct/coder models (llama-3.3-70b, qwen2.5-coder-32b) drop the very
// literal or line number being changed, so their edits fail to apply. Override
// with the AUTHOR_MODEL var (local: a `.dev.vars` line; deploy: `vars` in
// wrangler.jsonc). Cheaper/faster alternatives worth trying: "@cf/openai/
// gpt-oss-20b" or "@cf/qwen/qwen3-30b-a3b-fp8". The stream reader supports both
// the classic Workers AI ({response}) and OpenAI-style (choices[].delta.content)
// response schemas, so either family works.
const DEFAULT_MODEL = "@cf/openai/gpt-oss-120b";

// The OUTPUT FORMAT shared by the editor and repair passes. The model returns
// only the CHANGED regions as LINE operations (never the whole file), so output
// stays small and fast and a slip can't corrupt untouched code. Line ops (vs.
// search/replace) are far more reliable here: the model only has to cite line
// numbers from the numbered file we show it, and supply the NEW text — it never
// has to reproduce existing code verbatim (which smaller models do poorly, e.g.
// dropping the very literal being changed). The host applies the ops to the
// current file and pushes the final version.
const EDIT_OUTPUT_FORMAT = `OUTPUT FORMAT — LINE EDITS (follow EXACTLY):
The files below are shown with line numbers as "<n>| <code>". Those numbers are
NOT part of the code — never print them back. Return ONLY the changed regions as
line operations; do NOT reprint the whole file.

Emit operations under each file's header:

===EDIT: <path>===
@@REPLACE <start>-<end>@@
<new line(s) that replace the ORIGINAL lines start..end, inclusive>
@@INSERT <line>@@
<new line(s) inserted AFTER that line number; use 0 for the top of the file>
@@DELETE <start>-<end>@@
@@CREATE@@
<the entire contents of a brand-new file>

Rules:
- The LINE NUMBER IS MANDATORY. Read it off the "<n>| " prefix of the line you
  are changing and put it in the marker. "@@REPLACE@@" with no number is INVALID
  and will be rejected — it MUST be "@@REPLACE 33@@" (or a range "@@REPLACE 33-35@@").
- Line numbers refer to the CURRENT file as shown (1-indexed, inclusive). One
  line: "@@REPLACE 33@@" means the same as "@@REPLACE 33-33@@".
- An op's body is every line AFTER its @@...@@ marker, up to the next @@...@@
  marker, the next ===EDIT: header, or the end of output.
- DELETE takes no body. Repeat ===EDIT: per file; emit as many ops as needed.
- Do NOT reprint unchanged lines. Output NOTHING but headers and @@ ops — no
  prose, no markdown fences, and never the "<n>| " line-number prefixes.

Example — change starting chips on line 33 and the blinds on lines 34-35:
===EDIT: src/index.js===
@@REPLACE 33@@
var START = 2500;   // starting stack
@@REPLACE 34-35@@
var SB = 25;
var BB = 50;`;

const SYSTEM_PROMPT = `You are a code editor for a sandboxed Cloudflare Worker app.

RULES the code you output MUST follow:
- Provide a default export with an async fetch handler:
    export default { async fetch(request, env) { ... } }
- Persist data ONLY via the capability broker at env.SYSTEM:
    const store = await env.SYSTEM.requestStore("some-namespace");
    await store.put(key, value);   // value is a string
    const value = await store.get(key); // returns string | null
    await store.list();            // returns string[] of keys
    await store.delete(key);
- There is NO network access. Do not call fetch() to external URLs.
- Plain JavaScript only. No build step, no npm imports.

BUILD A REAL, INTERACTIVE WEB PAGE (this is important):
- GET "/" MUST return a complete HTML document (content-type "text/html")
  containing the visible UI: a display area AND interactive widgets
  (buttons/inputs/forms) the user can click to perform actions.
- Put actions behind data endpoints that return JSON (e.g. "inc", "save"),
  and have the page's client-side <script> call them and update the DOM.
- Use RELATIVE URLs everywhere in the page (e.g. fetch("inc"), NOT "/inc").
  The app is previewed under a subpath, so leading-slash URLs will not reach it.
- Keep all state on the server via env.SYSTEM stores; the page reflects it.

OPTIONAL — REALTIME / MULTIPLAYER:
If (and only if) the app needs live shared state across multiple browsers, add
two PURE named exports. Do NOT try to open WebSockets or hold connections in the
worker — the framework's realtime engine owns all of that and calls these for you:

    // Starting shared state for a fresh room/game.
    export const initialState = { ... };            // or a function

    // PURE reducer: (state, action, ctx) -> nextState. No fetch, no store.
    // Return state UNCHANGED to reject an action. Math.random() IS allowed here
    // (e.g. to shuffle a deck) — the result is persisted as the next state.
    export function applyAction(state, action, ctx) { ... }

- ctx is { seat, playerId }, supplied by the framework. "seat" is the player's
  assigned slot (or null for a spectator). Enforce turn/ownership rules by
  checking ctx.seat inside applyAction.

- SEATS (optional): seat names are declared BY YOUR APP, not the framework.
  Export a "seats" array to say which slots exist; the coordinator hands them out
  and passes one as ctx.seat. No "seats" export => everyone is a spectator.
    export const seats = ["X", "O"];        // or ["P1","P2",...] etc.

- HIDDEN INFORMATION (optional): by default every client sees the SAME state. If
  players must see DIFFERENT things (e.g. a poker hand only its owner can see),
  export a PURE view(state, ctx) that returns the slice that viewer may see. Keep
  ONE full state in applyAction; hide the secret parts in view. The framework
  sends each client its own projection.
    export function view(state, ctx) { ... } // ctx = { seat, playerId }

- The page's <script> connects with (derive the room from the page's OWN url so
  one page works in any room; missing ?room= => "main"):
    var ROOM = new URLSearchParams(location.search).get("room") || "main";
    new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+
      "/agents/app-host/"+encodeURIComponent(ROOM)+"?token="+TOKEN)
  sends { type:"action", action:{...} } frames, and re-renders on each incoming
  { type:"state", state, players } message. A { type:"welcome", seat } message
  arrives first with the client's own seat. Use an absolute ws:// URL here (this
  is the ONE exception to the relative-URL rule).

${EDIT_OUTPUT_FORMAT}`;

// System prompt for the self-heal REPAIR pass: the code already failed to build,
// so we hand the model the exact build error and ask for a minimal fix. Keeps
// the same hard rules + output format as the main editor.
const REPAIR_PROMPT = `You fix a FAILED edit to a sandboxed Cloudflare Worker app.

You are given the current files and the error from the previous attempt — either
a build error (the code didn't compile) or an apply error (a line op referenced a
line that doesn't exist). Fix it with minimal line-edit operations.

The code MUST still follow these rules:
- Default export with an async fetch handler: export default { async fetch(request, env) { ... } }.
- Persist ONLY via env.SYSTEM (requestStore(...).get/put/list/delete); values are strings.
- No external network access. Plain JavaScript only; no build step, no npm imports.
- Realtime apps may export pure applyAction(state, action, ctx), initialState, seats, view(state, ctx).

Common causes of the error: an incomplete expression (e.g. an empty value like
"{ key: }"), an unterminated string, a missing bracket/paren, or a stray token.

${EDIT_OUTPUT_FORMAT}`;

// Max tokens for the generated code. Workers AI defaults to a very small limit
// (~256), which truncates code mid-file and causes "Unterminated string literal"
// build errors. We request a large budget so whole files come back intact.
const MAX_OUTPUT_TOKENS = 8192;

/**
 * Render files as labelled, LINE-NUMBERED blocks for a prompt. The numbering
 * matches exactly what `applyEdits` operates on (a single trailing newline is
 * not counted as a line), so an op the model derives from this view lands on the
 * intended line.
 */
function renderFiles(files: AppFile[]): string {
  return files
    .map((f) => {
      const lines = contentLines(f.content);
      const width = String(lines.length).length;
      const numbered = lines
        .map((l, i) => `${String(i + 1).padStart(width, " ")}| ${l}`)
        .join("\n");
      return `--- FILE: ${f.path} (${lines.length} lines) ---\n${numbered}`;
    })
    .join("\n\n");
}

/**
 * Split file content into the addressable lines. A single trailing newline is a
 * terminator, not an empty final line, so it is not counted (both here and in
 * `applyEdits`). Everything else — including blank lines in the middle — counts.
 */
function contentLines(content: string): string[] {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.split("\n");
}

// Overall budget for one edit. A non-streamed request that runs longer than the
// model service allows fails with a hard "3046 Request timeout" and no partial
// output. We STREAM instead (tokens arrive continuously, so the request never
// sits idle long enough to trip that), and additionally enforce our own wall
// clock + idle guards so a stalled generation fails fast with a clear message
// instead of hanging. Override via the AUTHOR_TIMEOUT_MS var.
const DEFAULT_TIMEOUT_MS = 120_000;
// Max gap allowed between streamed chunks before we treat the stream as stalled.
// Generous, because a large model's time-to-FIRST-token (with a big prompt) can
// be tens of seconds even though it then streams steadily.
const IDLE_TIMEOUT_MS = 45_000;

interface AiRunInput {
  messages: { role: string; content: string }[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface AiBinding {
  run(
    model: string,
    input: AiRunInput
  ): Promise<ReadableStream<Uint8Array> | { response?: string }>;
}

/** Reject if `promise` doesn't settle within `ms` (with a labelled error). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), Math.max(0, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export class WorkersAiAuthor implements CodeAuthor {
  #ai: AiBinding;
  #model: string;
  #timeoutMs: number;

  constructor(ai: AiBinding, model: string = DEFAULT_MODEL, timeoutMs?: number | string) {
    this.#ai = ai;
    this.#model = model;
    const parsed = typeof timeoutMs === "string" ? Number(timeoutMs) : timeoutMs;
    this.#timeoutMs = Number.isFinite(parsed) && (parsed as number) > 0 ? (parsed as number) : DEFAULT_TIMEOUT_MS;
  }

  async edit(input: {
    instruction: string;
    files: AppFile[];
    declares: string[];
  }): Promise<AppFile[]> {
    const filesBlock = renderFiles(input.files);
    const userPrompt =
      `Current files:\n\n${filesBlock}\n\n` +
      `Allowed capabilities: ${input.declares.join(", ")}\n\n` +
      `Requested change: ${input.instruction}\n\n` +
      `Respond with line-edit operations (see OUTPUT FORMAT) — only the changed regions.`;
    const raw = await this.#generate(SYSTEM_PROMPT, userPrompt);
    return this.#applyOutput(raw, input.files);
  }

  async repair(input: {
    instruction: string;
    files: AppFile[];
    error: string;
    declares: string[];
  }): Promise<AppFile[]> {
    const filesBlock = renderFiles(input.files);
    const userPrompt =
      `Your PREVIOUS edit attempt FAILED. Fix it with minimal line-edit ops.\n\n` +
      `Original request (for context): ${input.instruction}\n\n` +
      `Allowed capabilities: ${input.declares.join(", ")}\n\n` +
      `ERROR:\n${input.error}\n\n` +
      `Current files (line numbers are authoritative — use them):\n\n${filesBlock}\n\n` +
      `Re-check the line numbers above before citing them. Respond with @@ line ` +
      `ops only; change as little as possible.`;
    const raw = await this.#generate(REPAIR_PROMPT, userPrompt);
    return this.#applyOutput(raw, input.files);
  }

  /**
   * Turn the model's raw output into the final file set. Prefers line-edit ops
   * (small, safe) applied to the current files; falls back to whole-file
   * `===FILE:` blocks if that's what the model returned.
   */
  #applyOutput(raw: string, current: AppFile[]): AppFile[] {
    const edits = parseEdits(raw);
    if (edits.length > 0) return applyEdits(current, edits);
    // Fallback: some responses (or brand-new tiny apps) come back as full files.
    return parseFiles(raw);
  }

  /** Run one chat completion (streamed) and return the raw accumulated text. */
  async #generate(system: string, user: string): Promise<string> {
    const result = await this.#ai.run(this.#model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.1,
      stream: true
    });

    let raw: string;
    if (isReadableStream(result)) {
      raw = await this.#drainStream(result);
    } else {
      // Some models/paths may ignore `stream` and return a plain object.
      raw = result.response ?? "";
    }

    if (raw.trim().length === 0) {
      throw new Error("The AI returned an empty response (it may have timed out).");
    }
    return raw;
  }

  /**
   * Consume a Workers AI SSE stream, accumulating the model's text. Enforces an
   * overall deadline and a per-chunk idle timeout so a stall surfaces a clear
   * error instead of hanging. On any failure the reader is cancelled.
   */
  async #drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + this.#timeoutMs;
    let buffer = "";
    let text = "";

    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `AI generation exceeded ${Math.round(this.#timeoutMs / 1000)}s. Try a smaller/simpler edit, or set AUTHOR_MODEL to a faster model.`
          );
        }
        const budget = Math.min(remaining, IDLE_TIMEOUT_MS);
        const { done, value } = await withTimeout(
          reader.read(),
          budget,
          "AI generation stalled (no output). Try again or use a faster model."
        );
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Workers AI streams Server-Sent Events: `data: {json}` lines, ending
        // with `data: [DONE]`. Each JSON payload carries a `response` token.
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload) as {
              response?: string;
              choices?: { delta?: { content?: string } }[];
            };
            // Classic Workers AI text-generation shape.
            if (typeof obj.response === "string") text += obj.response;
            // OpenAI-compatible shape (gpt-oss, glm, kimi, …): take only the
            // visible `content` delta — reasoning tokens are deliberately ignored.
            const content = obj.choices?.[0]?.delta?.content;
            if (typeof content === "string") text += content;
          } catch {
            // Ignore keep-alive / non-JSON lines.
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // best-effort
      }
    }
    return text;
  }
}

function isReadableStream(x: unknown): x is ReadableStream<Uint8Array> {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as ReadableStream).getReader === "function"
  );
}

/**
 * Parse the delimiter-based response into files.
 *
 * Format: repeated blocks of a `===FILE: path===` marker line followed by the
 * raw file contents, up to the next marker or end of text. This is robust for
 * arbitrary code (quotes, newlines) in a way JSON escaping is not. Throws if
 * nothing usable is found so a bad edit never corrupts stored state.
 */
export function parseFiles(raw: string): AppFile[] {
  const text = raw.replace(/\r\n/g, "\n");
  const marker = /^===FILE:\s*(.+?)\s*===\s*$/gm;

  const matches: { path: string; matchStart: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text)) !== null) {
    matches.push({
      path: m[1].trim(),
      matchStart: m.index,
      contentStart: marker.lastIndex
    });
  }

  if (matches.length === 0) {
    throw new Error("AI response did not contain any '===FILE: path===' markers.");
  }

  const files: AppFile[] = [];
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].matchStart : text.length;
    let content = text.slice(matches[i].contentStart, end);
    // Trim a single leading newline and trailing whitespace; strip stray fences.
    content = content.replace(/^\n/, "").replace(/\s+$/, "\n");
    content = content.replace(/^```[a-z]*\n/i, "").replace(/\n```\s*$/i, "\n");
    if (content.trim().length === 0) continue;
    files.push({ path: matches[i].path, content });
  }

  if (files.length === 0) {
    throw new Error("AI response contained markers but no file contents.");
  }
  return files;
}

/** A single line-addressed edit against one file. */
export interface FileEdit {
  path: string;
  op: "replace" | "insert" | "delete" | "create";
  // 1-indexed, inclusive. For "insert" `start` is the anchor line to insert
  // AFTER (0 = top of file) and `end` is unused. For "create" both are 0.
  start: number;
  end: number;
  body: string; // replacement / inserted / new-file text ("" for delete)
}

/**
 * Parse line-edit operations from the model output. Format:
 *
 *   ===EDIT: <path>===
 *   @@REPLACE <start>-<end>@@
 *   ...new lines...
 *   @@INSERT <line>@@
 *   ...new lines...
 *   @@DELETE <start>-<end>@@
 *   @@CREATE@@
 *   ...whole file...
 *
 * A `===EDIT:` header sets the target path for the ops that follow it. An op's
 * body runs until the next `@@...@@` op, the next header, or end of output.
 * Returns [] if nothing is found (the caller then falls back to whole-file
 * parsing).
 */
export function parseEdits(raw: string): FileEdit[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const header = /^===\s*EDIT[:\s]+(.+?)\s*===\s*$/;
  const op = /^@@\s*(REPLACE|INSERT|DELETE|CREATE)(?:\s+(\d+)(?:\s*-\s*(\d+))?)?\s*@@\s*$/i;

  const edits: FileEdit[] = [];
  let path: string | null = null;
  let pending: FileEdit | null = null;
  const body: string[] = [];

  const flush = () => {
    if (pending) {
      pending.body = body.join("\n");
      edits.push(pending);
      pending = null;
    }
    body.length = 0;
  };

  for (const line of lines) {
    const h = line.match(header);
    if (h) {
      flush();
      path = h[1].trim();
      continue;
    }
    const m = line.match(op);
    if (m && path) {
      flush();
      const kind = m[1].toLowerCase() as FileEdit["op"];
      // NaN marks a missing number so validation can flag it clearly (CREATE
      // legitimately has none). Note: 0 is a real, valid anchor for INSERT.
      const a = m[2] !== undefined ? Number(m[2]) : NaN;
      const b = m[3] !== undefined ? Number(m[3]) : a;
      pending = { path, op: kind, start: a, end: b, body: "" };
      continue;
    }
    if (pending) body.push(line);
  }
  flush();
  return edits;
}

/**
 * Apply line-edit operations to a file set, returning the new files. Line
 * numbers refer to the ORIGINAL file (as shown to the model); ops on one file
 * are applied bottom-up so earlier line numbers stay valid. Throws with a clear,
 * model-actionable message if an op is out of bounds or overlaps another, so a
 * bad edit never silently corrupts the app.
 */
export function applyEdits(files: AppFile[], edits: FileEdit[]): AppFile[] {
  const map = new Map(files.map((f) => [f.path, f.content]));
  const byPath = new Map<string, FileEdit[]>();
  for (const e of edits) {
    const list = byPath.get(e.path);
    if (list) list.push(e);
    else byPath.set(e.path, [e]);
  }

  const failures: string[] = [];

  for (const [path, ops] of byPath) {
    // CREATE replaces the whole file; if present it wins and line ops (which
    // would reference the old numbering) are ignored for this file.
    const create = ops.filter((o) => o.op === "create").pop();
    if (create) {
      map.set(path, ensureTrailingNewline(create.body));
      continue;
    }

    const current = map.get(path);
    if (current === undefined) {
      failures.push(`${path}: no such file to edit (use @@CREATE@@ for a new file)`);
      continue;
    }

    const hadTrailer = current.endsWith("\n");
    const lines = contentLines(current);
    const n = lines.length;

    // Validate bounds.
    let bad = false;
    for (const o of ops) {
      const K = o.op.toUpperCase();
      if (Number.isNaN(o.start) || (o.op !== "insert" && Number.isNaN(o.end))) {
        failures.push(`${path}: ${K} is missing its line number — write e.g. @@${K} 33@@ (or a range @@${K} 33-35@@).`);
        bad = true;
      } else if (o.op === "insert") {
        if (o.start < 0 || o.start > n) {
          failures.push(`${path}: INSERT after line ${o.start} is out of range (file has ${n} lines).`);
          bad = true;
        }
      } else if (o.start < 1 || o.end > n || o.start > o.end) {
        failures.push(`${path}: ${K} ${o.start}-${o.end} is out of range (file has ${n} lines).`);
        bad = true;
      }
    }
    if (bad) continue;

    // Detect overlapping replace/delete ranges (ambiguous outcome).
    const ranges = ops
      .filter((o) => o.op === "replace" || o.op === "delete")
      .map((o) => ({ start: o.start, end: o.end }))
      .sort((x, y) => x.start - y.start);
    let overlap = false;
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start <= ranges[i - 1].end) overlap = true;
    }
    if (overlap) {
      failures.push(`${path}: overlapping REPLACE/DELETE ranges — combine them into one op.`);
      continue;
    }

    // Apply bottom-up so original line numbers remain valid as we splice.
    const ordered = [...ops].sort((x, y) => y.start - x.start);
    for (const o of ordered) {
      const bodyLines = o.body === "" ? [] : o.body.split("\n");
      if (o.op === "insert") {
        lines.splice(o.start, 0, ...bodyLines);
      } else if (o.op === "delete") {
        lines.splice(o.start - 1, o.end - o.start + 1);
      } else {
        lines.splice(o.start - 1, o.end - o.start + 1, ...bodyLines);
      }
    }

    map.set(path, lines.join("\n") + (hadTrailer ? "\n" : ""));
  }

  if (failures.length > 0) {
    throw new Error(`Could not apply ${failures.length} edit(s):\n\n${failures.join("\n\n")}`);
  }
  return [...map.entries()].map(([path, content]) => ({ path, content }));
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
