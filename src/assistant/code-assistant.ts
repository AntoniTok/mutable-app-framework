import { Think, Session, defaultContextOverflowClassifier } from "@cloudflare/think";
import type {
  TurnContext,
  TurnConfig,
  MediaEvictionConfig,
  ContextOverflowConfig,
  ChatRecoveryConfig,
  ChatErrorClassification,
  ChatErrorContext
} from "@cloudflare/think";
import { getAgentByName } from "agents";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { createCodeTool, aiTools } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Env } from "../types";
import type { AppHost } from "../agent/app-host";
import type { AppFile } from "../templates/types";
import { getTemplate } from "../templates/registry";
import { applyEdits, type FileEdit } from "../author/workers-ai-author";

/**
 * CodeAssistant — the agentic coding assistant (a SEPARATE Durable Object).
 *
 * `AppHost` already `extends Agent` for a different purpose, so it cannot also
 * `extends Think`. Instead, one CodeAssistant lives PER ROOM, keyed by the same
 * room id as the room's AppHost. It reaches that AppHost over RPC through the
 * AppHost's existing public methods — never a raw binding — so the untrusted
 * app boundary is untouched: the app still sees ONLY `env.SYSTEM`.
 *
 * Design A ("bridged tools only"): the AppHost version store is the single
 * source of truth. Think's built-in workspace/bash tools are gated OFF (see
 * `beforeTurn` + `workspaceBash = false`); every edit flows through the tools
 * below into `AppHost.setFiles`, which BUILD-VALIDATES and only promotes code
 * that compiles. That build-gate is the quality bar, preserved unchanged.
 */

// Default assistant model. Must be a reliable TOOL-CALLER (distinct concern
// from the line-edit author's AUTHOR_MODEL). kimi-k2.7-code is a frontier-scale
// (1T-param) agentic coding model with a 262k context window, multi-turn tool
// calling and structured outputs — the strongest Workers-AI-hosted pick for this
// loop. Override per-instance with the ASSISTANT_MODEL var (see wrangler.jsonc).
const DEFAULT_ASSISTANT_MODEL = "@cf/moonshotai/kimi-k2.7-code";

// Cap on tool-call rounds per turn (bounds worst-case latency + cost). A large
// feature (e.g. "add split") legitimately needs many read/edit/preview rounds,
// so we give the model real room; kimi's 262k context comfortably holds the
// resulting transcript. This is a CEILING, not the typical turn — small tweaks
// still finish in 2-4 rounds. Raise if big features get cut off mid-work.
const MAX_STEPS = 20;

// kimi-k2.7-code is a REASONING model: left unbounded it spends the whole per-step
// output budget on reasoning tokens and the step ends with finishReason:"length"
// BEFORE it ever emits the tool call (the turn appears to "do nothing"). The fix
// is a LARGE per-step output budget so reasoning never crowds out the tool call —
// and so a save_version can emit a whole file without being truncated mid-string
// (which would surface as a build/JSON error). With that headroom we keep
// reasoning at "medium" (not "low"): too little reasoning makes the model punt on
// harder tasks with lazy "I can't do that" refusals instead of reading the files
// and editing. Tunable via env.
const MAX_OUTPUT_TOKENS = 32000;
const DEFAULT_REASONING_EFFORT = "medium";

// The assistant keeps its ENTIRE conversation in a Session and replays it every
// turn. A tool-heavy task (esp. read_file / save_version, which carry whole
// files) balloons that transcript; once the model-facing context gets large the
// model call slows to a crawl or stalls before emitting a tool call, so the turn
// appears to "do nothing" — and since history only grows, EVERY later turn fails
// the same way. We used to hand-roll a per-step truncation pass (a private
// `beforeStep` that clipped bulky payloads in older messages). Think ships that
// capability first-class, so we now use ITS machinery instead of duplicating it:
//
//   1. COMPACTION (configureSession): when the estimated transcript crosses
//      CONTEXT_TOKEN_BUDGET, Think compacts older messages into a summary overlay
//      (protecting a head + a recent tail, and keeping tool call/result pairs
//      intact). We register a DETERMINISTIC summarizer (no model call, never a
//      no-op) so the behaviour matches our old "cheap + reliable" clipping — the
//      elided middle is replaced by a marker telling the model to re-read files.
//   2. CONTEXT-OVERFLOW GUARDS (this.contextOverflow): a proactive guard compacts
//      in place before a step is predicted to overflow the window, and a reactive
//      backstop compacts + retries a turn that DID overflow — so a genuine
//      overflow surfaces as a recovered turn, not a silent stall.
//   3. MEDIA EVICTION (this.mediaEviction): large strings inside aged tool
//      outputs are evicted from durable storage too, so the boot/hydration
//      footprint doesn't grow without bound (guards SQLITE_NOMEM on long rooms).
//   4. CHAT RECOVERY (this.chatRecovery): turns are wrapped in a durable fiber so
//      a deploy / DO eviction / stream stall mid-turn is resumed, not lost.

// Recent messages kept fully intact by media eviction (compaction has its own
// head/tail protection). At least the last few carry the current file contents.
const KEEP_RECENT_MESSAGES = 14;
// Evict stored tool-output/text parts larger than this (bytes) from old messages.
const EVICT_PART_BYTES = 16000;
// Compact the transcript once its estimated size crosses this many tokens. kimi's
// window is 262k; we compact well before that so a long multi-step feature never
// crowds the model. Also the proactive context-overflow threshold.
const CONTEXT_TOKEN_BUDGET = 120_000;
// Deterministic replacement for the elided middle of a compacted transcript. No
// model call (so compaction is cheap and can never no-op); the app's files are
// always re-readable, and the prompt already steers the model to re-read.
const COMPACTION_SUMMARY =
  "[Earlier conversation was compacted to save context. File contents and history shown earlier may be stale — call read_file / list_files / list_versions / get_state to re-fetch anything you need before editing; do not rely on remembered file contents.]";

// The names of the tools this assistant exposes. `beforeTurn` restricts the
// model to THESE (plus the Session memory tool) so the built-in workspace
// tools — which would write to Think's scratch workspace, NOT the app — are
// unreachable. This is how Design A is enforced.
const TOOL_NAMES = [
  "list_files",
  "read_file",
  "apply_line_edits",
  "save_version",
  "preview",
  "list_versions",
  "rollback",
  "reset_app",
  "get_state",
  // Code Mode: the model writes ONE orchestration script that calls the
  // read/edit tools below, run in an isolated Dynamic Worker (no egress, no
  // bindings). See getTools() and invariant #11 in AGENTS.md.
  "code_mode"
] as const;

// The tools exposed INSIDE the Code Mode sandbox. Deliberately the read/edit
// loop only — NOT rollback/reset_app (destructive; better as explicit single
// top-level calls) and NOT code_mode itself (no recursion). Every one of these
// still routes writes through AppHost.setFiles's build-gate, so orchestrating
// them from a script changes only HOW MANY model round-trips it takes, never
// the promote path or the isolation boundary.
const CODE_MODE_SANDBOX_TOOLS = [
  "list_files",
  "read_file",
  "apply_line_edits",
  "save_version",
  "preview",
  "list_versions",
  "get_state"
] as const;

// Description for the code_mode tool. `{{types}}` is replaced by codemode with
// the TypeScript signatures generated from CODE_MODE_SANDBOX_TOOLS.
const CODE_MODE_DESCRIPTION = `Run ONE async arrow function that orchestrates several editing tools in a single step, instead of many separate tool calls. Best for MECHANICAL multi-step work: read a few files, apply a batch of edits, then preview — all at once.

Available inside the sandbox (call as codemode.<name>(...)):
{{types}}

Rules:
- Write a plain JavaScript async arrow function body; no TypeScript, no named functions.
- There is NO model reasoning inside the sandbox and NO network access — it runs isolated. Use it for deterministic sequences, not for anything needing you to "think" between steps.
- Each codemode.save_version / codemode.apply_line_edits returns the build outcome ({ built, live, status, error }). Read it and branch: if built is false, the version was NOT promoted, so re-read the current file (codemode.read_file) before trying again — do not compute new edits from a failed attempt's line numbers.
- For a large or quote-heavy file, prefer reading it, building the corrected WHOLE file as a string in JS, and calling codemode.save_version once — this avoids the stacked-line-edit fragility.
- Return a small summary object (e.g. { version, built }) so you can report what changed.`;

// Session-generated tools we allow through (writable "memory" block => set_context).
const SESSION_TOOL_NAMES = ["set_context"];

const SYSTEM_PROMPT = `You are the coding assistant for a self-modifying web app that lives inside this room. The app's source is stored as versioned files; each request runs the LIVE version in an isolated sandbox. You edit the app by calling tools — never by describing edits in prose.

WHAT YOU CAN DO (do NOT claim otherwise):
- You CAN read every source file with list_files / read_file. The whole app — HTML, CSS, and JS — lives in these files (often a single file). There are no hidden files you lack access to.
- You CAN see the RENDERED UI: call preview to run the live app and get its actual HTML output. You are NOT in a "text-only environment" and you are NOT blind to the layout — preview is your eyes.
- You CAN change anything in the app, including visual/layout/CSS changes (e.g. positioning players around a table), by editing the source files and saving a version.

NEVER REFUSE an in-app change or say you "can't see the UI", "don't have a preview", "need the user to point you to files", or "can't test in a browser". If you are unsure how something is built, DISCOVER it yourself: call read_file (and preview) FIRST, then make the edit. Attempt the change; only report a real, specific blocker (e.g. a build error you couldn't fix after trying).

THE APP CONTRACT (code you write MUST follow this):
- Default export with an async fetch handler: export default { async fetch(request, env) { ... } }.
- GET "/" returns a complete interactive HTML document (content-type "text/html"); actions live behind data endpoints returning JSON.
- Use RELATIVE URLs in the page (fetch("inc"), NOT "/inc") — the app is previewed under a subpath.
- Persist ONLY via env.SYSTEM. Key/value: const s = await env.SYSTEM.requestStore("ns"); s.put/get/list/delete (string values). For counters or any read-modify-write, use the ATOMIC ops s.incr(key, delta) (returns the new number) and s.cas(key, expected, next) — a get()+put() pair races under concurrent requests and loses updates, so never hand-roll a counter that way. Filesystem (small structured data, <=256KiB): const fs = await env.SYSTEM.requestFilesystem("ns"); fs.readFile/writeFile/readdir/mkdir/rm/stat/grep/find (relative paths).
- Large binary objects (images, audio, exports too big for the 256KiB fs cap): const blobs = await env.SYSTEM.requestBlobStore("ns"); blobs.put(key, bytesOrString)/get(key)->ArrayBuffer|null/delete(key)/list()->string[].
- NO direct network access. The ONLY way out is mediated fetch, and ONLY to hosts on this app's allowlist (managed by the user via the room's egress settings, NOT by you or the app): const net = await env.SYSTEM.requestFetch(); const res = await net.send(url, { method, headers, body }); res = { status, statusText, headers, body(ArrayBuffer) }. A host that isn't allowlisted throws — if the user wants a new API, tell them to add its host in egress settings. Plain JavaScript only; no build step, no npm imports.
- Realtime/multiplayer apps additionally export PURE functions: applyAction(state, action, ctx), optional initialState, seats, view(state, ctx). They hold no sockets.
- Editing code does NOT auto-wipe an in-progress game: the framework keeps the stored state across your edit when it stays compatible with the new code (it probes the old state against the new view/initialState). So DON'T worry that a cosmetic/logic tweak resets the game — it won't. Only if you make a BREAKING change to the state SHAPE should you add a pure migrate(oldState, oldStateVersion) export that reshapes old state for the new code (return undefined to decline and let it reset). Keep any existing migrate/stateVersion exports when editing.
- Realtime page clients MUST handle the reserved frame { type: "reload" } by calling location.reload() — the framework sends it when the app is edited to a new live version so EVERY open client picks up the new code (not just the editor). Keep this handler when editing an existing realtime page; add it when writing a new one.
- Realtime clients identify themselves with a stable "token" sent as ?token= on the WebSocket URL; the framework binds a seat to that token and resumes it on reconnect. Persist the token in localStorage (NOT sessionStorage) so closing/reopening the tab keeps the same seat; let an explicit ?player=<id> URL param override it (for multiple identities in one browser). Keep this scheme when editing an existing realtime page.

HOW TO EDIT (choose the cheapest tool that fits):
- For a SMALL, localized change, call read_file to see current line numbers, then apply_line_edits ONCE and stop. This is the fast path — prefer it for small tweaks.
- PREFER apply_line_edits even for most larger changes: make a series of targeted edits (read_file between them), not one giant rewrite. save_version requires you to re-emit the ENTIRE file as one tool argument; for a big or quote-heavy file that payload is large and easily malformed/truncated (a "JSON error passing the string"), so reserve save_version for a brand-new file or a near-total rewrite of a SMALL file. When in doubt, edit in place with apply_line_edits.
- Never fire multiple apply_line_edits in a row without a read_file in between: after any edit the line numbers move, so blind stacked edits land on the wrong lines.
- For MECHANICAL multi-step work — reading several files, applying a known batch of edits, then previewing — use code_mode: write ONE async arrow function that calls codemode.read_file / codemode.apply_line_edits / codemode.save_version / codemode.preview in sequence and returns a short summary. It runs the whole sequence in a single step (fewer round-trips) and can re-read a file inside the script to keep line numbers fresh. It runs ISOLATED with no network and cannot reason between steps, so use it for deterministic sequences, not for changes where you need to inspect output and decide what to do next — do those with the individual tools.
- After a risky change, call preview to verify the rendered output, then fix if needed.

EDITING THE HTML PAGE — READ THIS (this is where edits break most):
- Because the app source uses no backticks, the HTML page is usually built as an ARRAY OF SINGLE-QUOTED STRINGS joined together, e.g. var PAGE = [ '<div>', '<p>hi</p>', '</div>' ].join(''). read_file shows each HTML/JS line as its own '...' array element ending in a comma.
- To edit that page you edit ARRAY ELEMENTS, not raw HTML. Every line you insert or replace MUST be a complete single-quoted JS string ending in a comma, e.g. insert  '  <button id="splitBtn">Split</button>',  — NOT a bare <button> line. A line that isn't a valid quoted element (missing quote, missing trailing comma, an inner ' that isn't escaped) breaks the array literal and the build fails with "Expected ]".
- Use double quotes for HTML attributes inside the single-quoted string (class="x"), so you never need to escape quotes. To add several lines, insert several complete '...' element lines.
- The client behaviour lives in the '<script>' … '</' + 'script>' elements of that same array — same rule: each line stays a self-contained quoted string.

BUILD FAILURES (read carefully — this is the #1 way edits go wrong):
- A save is PROMOTED live only if it BUILDS. A version that fails to build is SAVED but DISCARDED — it does NOT become the base. The live app stays on the last good version, and read_file then returns THAT version, not your failed attempt.
- So after a build error: your changes are GONE. Do NOT compute a follow-up edit from the line numbers of your failed attempt — they no longer exist. Call read_file to see the CURRENT (last-good) file, then fix the exact error.
- If a build fails, read the error, call read_file to see the CURRENT last-good file, and make ONE corrected apply_line_edits. If it fails a SECOND time on the same spot, re-read that exact region and fix the specific syntax the error names (usually a broken quoted array element — an unbalanced quote/bracket or a missing trailing comma). Only fall back to save_version if the file is small; for a large file, keep fixing in place with targeted line edits rather than re-emitting the whole file.
- Use list_versions / rollback to inspect or revert history; reset_app re-seeds from the template.

Keep replies short. Do the work with tools; report what changed (and the resulting version) briefly.`;

/** Split file content into addressable lines (a single trailing newline is a terminator). */
function contentLines(content: string): string[] {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.split("\n");
}

/**
 * Render a file with 1-indexed line numbers so the model can cite exact
 * positions. An optional [from, to] window (1-indexed, inclusive) returns only
 * that slice while keeping the true line numbers, so a large file can be read
 * in pieces without bloating the transcript.
 */
function numbered(file: AppFile, from = 1, to?: number): string {
  const lines = contentLines(file.content);
  const width = String(lines.length).length;
  const start = Math.max(1, from);
  const end = Math.min(to ?? lines.length, lines.length);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    out.push(`${String(i).padStart(width, " ")}| ${lines[i - 1]}`);
  }
  return out.join("\n");
}

export class CodeAssistant extends Think<Env> {
  // Design A: no shell/bash tool. The workspace stays unused scratch; edits go
  // through the bridged tools into AppHost's build-gated version store.
  workspaceBash = false as const;

  maxSteps = MAX_STEPS;

  // Don't stream reasoning tokens to the client — the vanilla chat UI ignores
  // them, and this keeps the wire clean.
  sendReasoning = false;

  // Bound the persisted footprint: large strings inside aged tool outputs are
  // evicted from durable storage (kept only for the recent window), so a
  // long-lived room's hydration cost doesn't grow without bound. Compaction
  // (configureSession) handles the model-facing context; this handles disk.
  override mediaEviction: MediaEvictionConfig = {
    keepRecentMessages: KEEP_RECENT_MESSAGES,
    minPartBytes: EVICT_PART_BYTES,
    externalizeToWorkspace: false
  };

  // Context-window overflow guards (Think built-ins, replacing the old
  // hand-rolled per-step clipping). Proactive: compact in place before a step is
  // predicted to cross the budget. Reactive: if a turn overflows anyway, compact
  // + retry once rather than surfacing a silent stall. Both call session.compact()
  // — see the deterministic compaction registered in configureSession.
  override contextOverflow: ContextOverflowConfig = {
    reactive: true,
    maxRetries: 1,
    proactive: { maxInputTokens: CONTEXT_TOKEN_BUDGET }
  };

  // Map raw provider errors to a provider-agnostic category so contextOverflow's
  // reactive backstop knows an overflow when it sees one. The bundled classifier
  // covers the common providers (incl. Workers AI).
  override classifyChatError(
    error: unknown,
    _ctx?: ChatErrorContext
  ): ChatErrorClassification | void {
    return defaultContextOverflowClassifier(error);
  }

  // Durable turn recovery: wrap each turn in a fiber so a deploy, DO eviction, or
  // stream stall mid-turn is resumed (or terminalized cleanly) instead of leaving
  // the client spinning. Assigned as a class field (NOT in onStart) as required.
  override chatRecovery: ChatRecoveryConfig = {
    maxAttempts: 6,
    terminalMessage:
      "The assistant was interrupted and couldn't finish that turn. Please try again."
  };

  getModel(): string {
    return this.env.ASSISTANT_MODEL || DEFAULT_ASSISTANT_MODEL;
  }

  getSystemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  /**
   * One writable "memory" block per room, so the model can persist durable
   * facts about this app across turns/sessions (e.g. "uses poker seats P1-P6").
   * Conversation history + FTS5 search come for free from the Session store.
   *
   * Also registers DETERMINISTIC compaction: when the estimated transcript
   * crosses CONTEXT_TOKEN_BUDGET, Think's reference algorithm protects a head +
   * recent tail (keeping tool call/result pairs intact) and replaces the middle
   * with COMPACTION_SUMMARY. We pass a `summarize` that returns that fixed marker
   * instead of calling a model, so compaction stays cheap and can never no-op —
   * the app's files are always re-readable, which the system prompt relies on.
   * This (plus contextOverflow + mediaEviction) is what replaced the old
   * per-step `beforeStep` clipping.
   */
  configureSession(session: Session): Session {
    return session
      .withContext("memory", {
        description:
          "Durable facts about THIS room's app: what it does, its endpoints, storage namespaces, seats/views, and user preferences. Update as you learn.",
        maxTokens: 2000
      })
      .onCompaction(
        createCompactFunction({
          summarize: async () => COMPACTION_SUMMARY
        })
      )
      .compactAfter(CONTEXT_TOKEN_BUDGET)
      .withCachedPrompt();
  }

  /**
   * Gate the model to our bridged tools (+ the memory write tool). This makes
   * Think's built-in workspace/bash tools unreachable, enforcing Design A: the
   * only path to app code is through AppHost's build-gated methods.
   */
  beforeTurn(_ctx: TurnContext): TurnConfig {
    return {
      activeTools: [...TOOL_NAMES, ...SESSION_TOOL_NAMES],
      // Headroom so reasoning doesn't crowd out the tool call (see MAX_OUTPUT_TOKENS).
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // Workers AI reads reasoning_effort off providerOptions["workers-ai"].
      providerOptions: {
        "workers-ai": {
          reasoning_effort: this.env.ASSISTANT_REASONING_EFFORT || DEFAULT_REASONING_EFFORT
        }
      }
    };
  }

  /** RPC stub for this room's AppHost (same room id => this.name). */
  #host(): Promise<DurableObjectStub<AppHost>> {
    return getAgentByName<Env, AppHost>(this.env.AppHost, this.name);
  }

  /** Capabilities the hosted app declares (for prompt/error context). */
  async #declares(): Promise<string[]> {
    const host = await this.#host();
    const status = await host.getStatus();
    return getTemplate(status.templateId).declares;
  }

  /**
   * After any write, report the outcome the same way the UI would read it:
   * the new version plus whether it built (and thus went live) or was saved
   * broken (live pointer unchanged).
   */
  async #outcome(host: DurableObjectStub<AppHost>, version: number): Promise<{
    version: number;
    built: boolean;
    live: number;
    status: string;
    error: string | null;
    guidance?: string;
  }> {
    const s = await host.getStatus();
    const built = s.status === "ready" && s.activeVersion === version;
    if (built) {
      return { version, built, live: s.activeVersion, status: s.status, error: s.lastError };
    }
    // CRITICAL: a version that fails to build is saved but NOT promoted. The live
    // base stays on the last good version (`live` below), and getFiles/read_file
    // now return THAT — your just-attempted changes are GONE from the base. If you
    // retry with more line edits computed against your failed attempt, the line
    // numbers will be wrong and you'll corrupt the file further (this is how a
    // single failure snowballs). So: this build FAILED and was discarded.
    return {
      version,
      built,
      live: s.activeVersion,
      status: s.status,
      error: s.lastError,
      guidance:
        `Build FAILED — this version was NOT applied. The live app is still v${s.activeVersion}, ` +
        `and read_file now reflects v${s.activeVersion} (NOT your failed attempt). ` +
        `Do NOT send another apply_line_edits based on your last attempt's line numbers. ` +
        `Instead: call read_file to get the CURRENT lines of v${s.activeVersion}, then either make ONE ` +
        `corrected apply_line_edits, or — for a structural/layout change — call save_version with the ` +
        `COMPLETE corrected file. Fix the exact error above (e.g. unterminated string, missing bracket).`
    };
  }

  /**
   * The individual bridged tools. Each `execute` runs HOST-SIDE (trusted) and
   * touches app code only through AppHost's build-gated methods. These are used
   * two ways: exposed directly to the model (getTools), and — a curated subset —
   * exposed INSIDE the Code Mode sandbox (see getTools + CODE_MODE_SANDBOX_TOOLS).
   */
  #toolDefs(): ToolSet {
    return {
      list_files: tool({
        description: "List the paths of the app's current live files.",
        inputSchema: z.object({}),
        execute: async () => {
          const files = await (await this.#host()).getFiles();
          return { files: files.map((f) => f.path) };
        }
      }),

      read_file: tool({
        description:
          "Read one live file's contents, shown with 1-indexed line numbers. Use the line numbers to build apply_line_edits ops. For a LARGE file, read only the slice you need by passing startLine/endLine (omit both to read the whole file) — this keeps the conversation small so long sessions don't stall.",
        inputSchema: z.object({
          path: z.string().describe("File path, e.g. src/index.js"),
          startLine: z
            .number()
            .int()
            .optional()
            .describe("1-indexed first line to return (inclusive). Omit to start at line 1."),
          endLine: z
            .number()
            .int()
            .optional()
            .describe("1-indexed last line to return (inclusive). Omit to read to end of file.")
        }),
        execute: async ({ path, startLine, endLine }) => {
          const files = await (await this.#host()).getFiles();
          const file = files.find((f) => f.path === path);
          if (!file) {
            return { error: `No such file: ${path}. Available: ${files.map((f) => f.path).join(", ")}` };
          }
          const total = contentLines(file.content).length;
          const from = startLine && startLine > 0 ? startLine : 1;
          const to = endLine && endLine > 0 ? Math.min(endLine, total) : total;
          if (from > total) {
            return { path, lines: total, error: `startLine ${from} is past end of file (${total} lines).` };
          }
          const windowed = from > 1 || to < total;
          return {
            path,
            lines: total,
            ...(windowed ? { range: { startLine: from, endLine: to } } : {}),
            content: numbered(file, from, to)
          };
        }
      }),

      apply_line_edits: tool({
        description:
          "FAST PATH for small, localized changes. Apply line-addressed edit operations to existing files, then save+build the result. Line numbers refer to the CURRENT file as shown by read_file (1-indexed, inclusive).",
        inputSchema: z.object({
          note: z.string().describe("Short summary of the change (becomes the version note)."),
          edits: z
            .array(
              z.object({
                path: z.string(),
                op: z.enum(["replace", "insert", "delete", "create"]),
                start: z
                  .number()
                  .describe(
                    "1-indexed line. For insert, the anchor to insert AFTER (0 = top). For create, 0."
                  ),
                end: z
                  .number()
                  .describe("Inclusive end line (same as start for a single line; 0 for insert/create)."),
                body: z
                  .string()
                  .default("")
                  .describe("New/replacement/inserted text, or whole file for create. Empty for delete.")
              })
            )
            .min(1)
        }),
        execute: async ({ note, edits }) => {
          const host = await this.#host();
          const files = await host.getFiles();
          let next: AppFile[];
          try {
            next = applyEdits(files, edits as FileEdit[]);
          } catch (err) {
            // Bad op (out of range / overlap) — hand the model the exact reason.
            return { applied: false, error: err instanceof Error ? err.message : String(err) };
          }
          const version = await host.setFiles(next, `ai: ${note}`);
          return { applied: true, ...(await this.#outcome(host, version)) };
        }
      }),

      save_version: tool({
        description:
          "Save a COMPLETE set of files as a new version (use for new files or large rewrites). The version is saved, built, and promoted live only if it compiles.",
        inputSchema: z.object({
          note: z.string(),
          files: z.array(z.object({ path: z.string(), content: z.string() })).min(1)
        }),
        execute: async ({ note, files }) => {
          const host = await this.#host();
          const version = await host.setFiles(files as AppFile[], `ai: ${note}`);
          return await this.#outcome(host, version);
        }
      }),

      preview: tool({
        description:
          "Run the live app and return its response, so you can verify a change. Defaults to GET /.",
        inputSchema: z.object({
          path: z.string().default("/"),
          method: z.string().default("GET"),
          body: z.string().nullable().default(null)
        }),
        execute: async ({ path, method, body }) => {
          const host = await this.#host();
          const appPath = path.startsWith("/") ? path : `/${path}`;
          const result = await host.preview({
            url: `http://app${appPath}`,
            method,
            headers: [],
            body: method === "GET" || method === "HEAD" ? null : body
          });
          const text = new TextDecoder().decode(result.body);
          const MAX = 4000;
          return {
            status: result.status,
            contentType: result.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "",
            body: text.length > MAX ? `${text.slice(0, MAX)}\n…[truncated ${text.length - MAX} chars]` : text
          };
        }
      }),

      list_versions: tool({
        description: "List saved versions (newest first): id, timestamp, note.",
        inputSchema: z.object({}),
        execute: async () => {
          const versions = await (await this.#host()).listVersions();
          return { versions };
        }
      }),

      rollback: tool({
        description: "Move the live pointer to an older version id.",
        inputSchema: z.object({ version: z.number() }),
        execute: async ({ version }) => {
          const host = await this.#host();
          await host.rollback(version);
          const s = await host.getStatus();
          return { live: s.activeVersion, status: s.status, error: s.lastError };
        }
      }),

      reset_app: tool({
        description: "Re-seed the app from its template as a new version (clean slate; history kept).",
        inputSchema: z.object({}),
        execute: async () => {
          const host = await this.#host();
          const version = await host.resetToTemplate();
          return await this.#outcome(host, version);
        }
      }),

      get_state: tool({
        description:
          "Get the app's current status: live version, build status (ready/building/error), declared capabilities, and last error.",
        inputSchema: z.object({}),
        execute: async () => {
          const host = await this.#host();
          const s = await host.getStatus();
          return {
            live: s.activeVersion,
            status: s.status,
            templateId: s.templateId,
            declares: getTemplate(s.templateId).declares,
            error: s.lastError
          };
        }
      })
    };
  }

  /**
   * The tools the model can call. All the bridged tools directly, PLUS a
   * `code_mode` tool that lets the model write ONE orchestration script over a
   * curated subset of them.
   *
   * ISOLATION (invariant #11): the Code Mode script runs in its own Dynamic
   * Worker via `DynamicWorkerExecutor`, which defaults to `globalOutbound: null`
   * (no egress) and receives ONLY ToolDispatchers for CODE_MODE_SANDBOX_TOOLS —
   * never `env`, a binding, or a workspace/state provider. Each dispatched tool's
   * `execute` still runs host-side and still writes through AppHost.setFiles's
   * build-gate, so the untrusted-app boundary and the promote path are unchanged.
   * This adds a SECOND sandbox (for the assistant's orchestration); the app's own
   * sandbox in runner.ts is untouched.
   */
  getTools(): ToolSet {
    const defs = this.#toolDefs();

    // Curated read/edit subset handed into the sandbox (never rollback/reset).
    const sandboxTools: ToolSet = {};
    for (const name of CODE_MODE_SANDBOX_TOOLS) sandboxTools[name] = defs[name];

    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER
      // globalOutbound defaults to null (fully isolated) — do NOT pass a Fetcher
      // or any bindings; the sandbox reaches the host only via the tool RPC.
    });

    const code_mode = createCodeTool({
      tools: [aiTools(sandboxTools)],
      executor,
      description: CODE_MODE_DESCRIPTION
    });

    return { ...defs, code_mode };
  }
}
