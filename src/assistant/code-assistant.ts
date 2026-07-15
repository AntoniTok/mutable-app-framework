import { Think, Session } from "@cloudflare/think";
import type { TurnContext, TurnConfig } from "@cloudflare/think";
import { getAgentByName } from "agents";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
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
// from the line-edit author's AUTHOR_MODEL). gpt-oss-120b is OpenAI-style and
// tool-capable; override per-instance with the ASSISTANT_MODEL var.
const DEFAULT_ASSISTANT_MODEL = "@cf/openai/gpt-oss-120b";

/** Cap on tool-call rounds per turn (bounds worst-case latency + cost). */
const MAX_STEPS = 12;

// gpt-oss is a REASONING model: left unbounded it spends the whole per-step
// output budget on reasoning tokens and the step ends with finishReason:"length"
// BEFORE it ever emits the tool call (the turn appears to "do nothing"). The fix
// is a LARGE per-step output budget so reasoning never crowds out the tool call.
// With that headroom we keep reasoning at "medium" (not "low"): too little
// reasoning makes the model punt on harder tasks with lazy "I can't do that"
// refusals instead of reading the files and editing. Tunable via env.
const MAX_OUTPUT_TOKENS = 16000;
const DEFAULT_REASONING_EFFORT = "medium";

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
  "get_state"
] as const;

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
- Persist ONLY via env.SYSTEM. Key/value: const s = await env.SYSTEM.requestStore("ns"); s.put/get/list/delete (string values). Filesystem (small structured data, <=256KiB): const fs = await env.SYSTEM.requestFilesystem("ns"); fs.readFile/writeFile/readdir/mkdir/rm/stat/grep/find (relative paths).
- NO external network access. Plain JavaScript only; no build step, no npm imports.
- Realtime/multiplayer apps additionally export PURE functions: applyAction(state, action, ctx), optional initialState, seats, view(state, ctx). They hold no sockets.
- Realtime page clients MUST handle the reserved frame { type: "reload" } by calling location.reload() — the framework sends it when the app is edited to a new live version so EVERY open client picks up the new code (not just the editor). Keep this handler when editing an existing realtime page; add it when writing a new one.
- Realtime clients identify themselves with a stable "token" sent as ?token= on the WebSocket URL; the framework binds a seat to that token and resumes it on reconnect. Persist the token in localStorage (NOT sessionStorage) so closing/reopening the tab keeps the same seat; let an explicit ?player=<id> URL param override it (for multiple identities in one browser). Keep this scheme when editing an existing realtime page.

HOW TO EDIT (choose the cheapest tool that fits):
- For a SMALL, localized change, call read_file to see current line numbers, then apply_line_edits ONCE and stop. This is the fast path — prefer it for small tweaks.
- For a brand-new file, a large/structural change, or ANYTHING touching layout/CSS/how the UI is assembled, use save_version with the COMPLETE file. Line surgery on structural changes drifts and corrupts — send the whole file instead.
- Never fire multiple apply_line_edits in a row without a read_file in between: after any edit the line numbers move, so blind stacked edits land on the wrong lines.
- After a risky change, call preview to verify the rendered output, then fix if needed.

BUILD FAILURES (read carefully — this is the #1 way edits go wrong):
- A save is PROMOTED live only if it BUILDS. A version that fails to build is SAVED but DISCARDED — it does NOT become the base. The live app stays on the last good version, and read_file then returns THAT version, not your failed attempt.
- So after a build error: your changes are GONE. Do NOT compute a follow-up edit from the line numbers of your failed attempt — they no longer exist. Call read_file to see the CURRENT (last-good) file, then fix the exact error.
- If a build fails TWICE, stop using apply_line_edits and switch to save_version with the complete corrected file. Do not keep stacking line edits.
- Use list_versions / rollback to inspect or revert history; reset_app re-seeds from the template.

Keep replies short. Do the work with tools; report what changed (and the resulting version) briefly.`;

/** Split file content into addressable lines (a single trailing newline is a terminator). */
function contentLines(content: string): string[] {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.split("\n");
}

/** Render one file with 1-indexed line numbers so the model can cite exact positions. */
function numbered(file: AppFile): string {
  const lines = contentLines(file.content);
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width, " ")}| ${l}`).join("\n");
}

export class CodeAssistant extends Think<Env> {
  // Design A: no shell/bash tool. The workspace stays unused scratch; edits go
  // through the bridged tools into AppHost's build-gated version store.
  workspaceBash = false as const;

  maxSteps = MAX_STEPS;

  // Don't stream reasoning tokens to the client — the vanilla chat UI ignores
  // them, and this keeps the wire clean.
  sendReasoning = false;

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
   */
  configureSession(session: Session): Session {
    return session
      .withContext("memory", {
        description:
          "Durable facts about THIS room's app: what it does, its endpoints, storage namespaces, seats/views, and user preferences. Update as you learn.",
        maxTokens: 2000
      })
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

  getTools(): ToolSet {
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
          "Read one live file's contents, shown with 1-indexed line numbers. Use the line numbers to build apply_line_edits ops.",
        inputSchema: z.object({ path: z.string().describe("File path, e.g. src/index.js") }),
        execute: async ({ path }) => {
          const files = await (await this.#host()).getFiles();
          const file = files.find((f) => f.path === path);
          if (!file) {
            return { error: `No such file: ${path}. Available: ${files.map((f) => f.path).join(", ")}` };
          }
          return { path, lines: contentLines(file.content).length, content: numbered(file) };
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
}
