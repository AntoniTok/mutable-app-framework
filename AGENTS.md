# AGENTS.md — orientation for coding agents

Read `README.md` for the full picture. This file is the fast path + the
invariants you must not break.

## What this is (one line)

A self-modifying app framework: an app's source lives as data in a Durable
Object; each request runs the live version in an isolated Dynamic Worker; edits
(manual or AI) create new versions with no redeploy.

## Where things are

- `src/server.ts` — entry Worker; routes `/api/*`, `/preview/*`, `/agents/*`.
  Exports the DOs + capability entrypoints + `DynamicWorkerTail`.
- `src/agent/app-host.ts` — the Agent (DO). Source of truth for CODE + all
  actions. Forwards the app's runtime data (store + fs) to the facet.
- `src/agent/runner.ts` — runs untrusted app code in a Dynamic Worker (injects
  the `SYSTEM` broker, `globalOutbound: null`, and attaches the tail worker).
- `src/agent/schema.ts` — AppHost's SQLite tables + query helpers (`files`,
  `versions`; `app_data` now holds ONLY the realtime `__room__` scope).
- `src/agent/facet/entry.ts` — the `AppStorageFacet` Durable Object: an app's
  runtime data (key/value store + dofs filesystem) in its OWN isolated SQLite,
  run as a facet beneath AppHost. Bundled (with tree-shaken dofs) to a string by
  `scripts/build-facet.mjs` → `src/agent/facet/bundle.generated.ts`.
- `src/agent/app-storage-facet.ts` — the facet surface: re-exports the bundled
  source, the loader id / facet name, and the RPC stub type.
- `src/observability/dynamic-worker-tail.ts` — `DynamicWorkerTail`: captures each
  untrusted app run's logs/exceptions/outcome into Workers Logs, tagged by
  `workerId` (attached in `runner.ts`).
- `src/capabilities/{broker,scoped-store,scoped-filesystem}.ts` — capability
  sandbox.
- `src/assistant/code-assistant.ts` — the AI coding assistant, a SEPARATE Durable
  Object `CodeAssistant extends Think` (`@cloudflare/think`). One per room, keyed
  by the room id. Runs the agentic loop (model calls host-side tools → reads
  results → loops) with per-room memory (Session context block). Its tools reach
  the room's `AppHost` by RPC (`getAgentByName`) and edit code ONLY through
  `AppHost.setFiles` (build-gated). This is now the primary AI-edit path.
- `src/author/*` — the line-edit engine (`parseEdits`/`applyEdits`/`FileEdit`)
  reused by the assistant's `apply_line_edits` tool. `WorkersAiAuthor` (the old
  one-shot `CodeAuthor`) is retained but no longer wired to `AppHost`.
- `src/templates/types.ts` — the app contract. `examples/poker.ts` (realtime +
  hidden information), `examples/tictactoe.ts` (realtime), `examples/counter.ts`
  (HTTP-only) and `examples/notes.ts` (filesystem capability) = example apps.
- `src/realtime/coordinator.ts` — the realtime engine (WS/presence/seats/
  per-player broadcast) that drives the app's pure `applyAction` reducer and
  optional `view` projection. State transitions are serialized (a promise chain)
  so concurrent frames don't race. Pure-reducer path is live; `broker.requestRoom`
  (app-driven realtime) is still a reserved future consumer. On a successful
  promote, `AppHost` also broadcasts a debounced `{type:"reload"}` frame so every
  connected client reloads onto the new code (not just the editor's tab).
- `public/index.html` — the lobby (create/join a room), served at `/`.
- `public/room.html` — the room page (vanilla JS), served at `/room.html?room=<id>`.
  Shows the live app (the game) by default; an **Edit** button reveals the
  editor tools (Run/preview, **Chat**, Code, History). The **Chat** panel is a
  vanilla-JS client for `CodeAssistant`, speaking the Agents chat WebSocket
  protocol (`cf_agent_chat_*`) on `/agents/code-assistant/<room>`.

## Multi-room

Each room is an isolated app instance = one `AppHost` Durable Object, keyed by
its id via `getAgentByName(env.AppHost, roomId)`. Per room: its own code,
version history and realtime state. The room id comes from the `?room=` query
param on `/api/*` and `/preview/*` (sanitized to `[A-Za-z0-9_-]`, cap 64), and
is the DO name on the `/agents/app-host/<room>` WS route. Missing/invalid =>
`main` (back-compat). The served page self-locates its room from its own
`location` (`?room=`), so the same HTML works in any room.

The room's `CodeAssistant` is keyed the SAME way — `getAgentByName(env.CodeAssistant,
roomId)` — so room `r`'s assistant always drives room `r`'s `AppHost`. Two DOs
per room (app + assistant), same id.

## Invariants — DO NOT break these

1. **App code is untrusted.** In `runner.ts` the Dynamic Worker gets ONLY
   `env = { SYSTEM: broker }` and `globalOutbound: null`. Never pass real
   bindings/secrets into the loaded worker.
2. **New capabilities go through the broker**, scoped by `props.instance`. Don't
   hand raw resources to apps. Follow the `requestStore` pattern.
3. **Code lives in SQL, not synced state.** `this.setState` holds only the small
   pointer `{ activeVersion, status, templateId, lastError }`. Never put file
   contents in state (it's broadcast to all clients).
4. **The framework core stays app-agnostic.** It only touches `AppTemplate` /
   the runtime contract — never concrete app content. Example apps live under
   `src/templates/examples/`.
5. **The AI assistant is TRUSTED host-side code and stays on its side of the
   sandbox.** `CodeAssistant` (Think) and its tools run in the host, exactly like
   the old author. Tools that touch app code MUST go through `AppHost`'s public
   methods (`getFiles`/`setFiles`/`preview`/`listVersions`/`rollback`/
   `resetToTemplate`/`getStatus`) — the ONLY promote path is `setFiles`, which
   build-validates and refuses to promote code that doesn't compile. NEVER hand a
   real binding to the app, and NEVER let the assistant write app code by any path
   that skips the build-gate. Think's built-in workspace/bash tools are gated OFF
   (`workspaceBash = false` + `beforeTurn` `activeTools`) so the model can only
   use the bridged tools. `AppHost` already `extends Agent`, so it cannot also
   `extends Think` (single inheritance) — that is why the assistant is a separate DO.
6. **Lifecycle methods aren't RPC-callable** on the Agents stub. Preview runs via
   the custom `AppHost.preview()` method (returns serializable data), not
   `onRequest`. Keep host↔agent calls as explicit public methods. (WebSocket
   lifecycle — `onConnect`/`onMessage`/`onClose` — is the exception: it's invoked
   by `routeAgentRequest`, and delegates to the realtime coordinator.)
7. **Realtime apps stay pure.** The untrusted app NEVER holds a socket or does
   I/O for multiplayer. It exports pure functions only — `applyAction(state,
   action, ctx)` (+ optional `initialState`, `view`, `seats`); the trusted
   coordinator owns the WebSockets, presence/seats, persistence and broadcast,
   and invokes them in the sandbox via `runner.reduce()` / `runner.project()` /
   `runner.seats()`. The reducer is side-effect-free but `Math.random()` IS
   allowed (its result is persisted as the next state — e.g. shuffling a deck).
   Realtime state lives in `app_data` under the reserved `__room__` scope — never
   in `this.setState` (invariant #3).

8. **Seats are app-defined; the core names none.** Seat labels come from the
   app's optional `seats` export (e.g. `["X","O"]`, `["P1".."P6"]`). No `seats`
   export ⇒ everyone is a spectator (`ctx.seat === null`).

9. **Asymmetric views go through `view`, not the reducer.** For hidden
   information (poker hands, etc.) the reducer keeps ONE full authoritative
   state; an optional pure `view(state, ctx)` projects the slice each viewer may
   see. The coordinator projects per connection (batched) and sends each client
   its own frame. No `view` export ⇒ the full state is broadcast to everyone
   (symmetric apps like tic-tac-toe, unchanged). NEVER put secrets only in the
   reducer's broadcast path — redact them in `view`.

10. **App runtime data lives in a FACET, still behind the broker.** An app's own
    store (`requestStore`) and filesystem (`requestFilesystem`) are backed by the
    `AppStorageFacet` — a child DO with its OWN isolated SQLite, reached via
    `AppHost.#appData()` (`this.ctx.facets.get(...)`). AppHost only holds CODE
    (plus the realtime `__room__` scope). This changes WHERE the bytes live, not
    HOW they're reached: the untrusted app still can't touch the facet directly —
    the broker's scoped stubs validate/quota/sanitise every call, and AppHost
    forwards it in. Facets add isolation; the broker keeps policy. The facet class
    is TRUSTED framework code (`src/agent/facet/entry.ts`), delivered via the
    Worker Loader (`getDurableObjectClass`) and loaded with `nodejs_compat`
    (dofs needs `node:crypto`/`node:events`). Regenerate the bundle with
    `npm run build:facet` after editing the facet or bumping vendored dofs.

## The runtime contract apps must follow

Default export `fetch(request, env)`; HTML page at `/`; persist via
`env.SYSTEM.requestStore(...)`; no network; relative URLs in HTML. Multiplayer
apps additionally export a pure `applyAction(state, action, ctx)` (+ optional
`initialState`, `seats`, and `view(state, ctx)` for hidden information) and
connect a WebSocket to `/agents/app-host/<room>?token=<id>` (the room read from
the page's own `location`, default `main`). The realtime client MUST also handle
the reserved `{type:"reload"}` frame (`location.reload()`) so it picks up new code
after an edit, and should derive its `token` so identity is stable across
reload/reopen (see Player identity below). See `src/templates/types.ts` and the
assistant's system prompt in `src/assistant/code-assistant.ts` (keep the two in
sync — that prompt is what the AI reads when writing app code).

### Live reload + player identity

- **Live reload:** `AppHost.setFiles` (and `rollback`) broadcast `{type:"reload"}`
  to all connected clients when a version is PROMOTED (build succeeded), debounced
  by `RELOAD_DEBOUNCE_MS` (750 ms) so a multi-promote turn = one reload; a failed
  build never reloads. App pages opt in by handling the frame.
- **Player identity:** seats bind to the `?token=` on the WS URL. `room.html`
  mints a per-tab id and writes it into the tab's address bar (`?player=`, via
  `replaceState`) and forwards it to the preview iframe — so multiple tabs are
  distinct players, and reload/reopen resumes the seat. "Copy link" omits
  `player=` (clean invites). App pages fall back to a per-browser `localStorage`
  id when opened directly, and honor an explicit `?player=` override.

## AI editing (the assistant)

Editing is a multi-turn CHAT with `CodeAssistant` (Think), not a one-shot call.
The model runs an agentic loop over host-side tools: `list_files`, `read_file`,
`apply_line_edits` (the FAST path — reuses `applyEdits` from `src/author/`),
`save_version`, `preview`, `list_versions`, `rollback`, `reset_app`, `get_state`.
Every write goes through `AppHost.setFiles`, so the build-gate + version history
are unchanged: broken code is saved-not-promoted, good code auto-promotes. The
loop reading a returned build error and fixing it IS the self-heal (no separate
repair loop) — the failed-build tool result also tells the model the base
reverted (not promoted), steering it to re-read or switch to `save_version`.
Per-room memory is a writable Session context block (`set_context`). Model set via
`ASSISTANT_MODEL` — **pinned to `@cf/zai-org/glm-5.2`** in `wrangler.jsonc` `vars`
(hardcoded fallback `@cf/openai/gpt-oss-120b`); it must be a reliable tool-caller.
Reasoning models get `beforeTurn` guards: a large `maxOutputTokens` (so reasoning
can't crowd out the tool call) and `reasoning_effort` (default `medium`, tunable
via `ASSISTANT_REASONING_EFFORT`). There is no `/api/edit` HTTP route anymore.

## One app at a time

This framework hosts ONE app. The hosted app is chosen by the SINGLE constant
`DEFAULT_TEMPLATE_ID` in `src/templates/registry.ts` (currently `poker`);
`AppHost.initialState.templateId` derives from it. Every room seeds from it. To
build a different app, change that one line (e.g. `"tictactoe"` or `"counter"`)
and/or the template's files. Note: a room already in `.wrangler/` keeps its
seeded code — use a fresh room id (or clear `.wrangler/`) after switching. The
four example apps (`poker`, `tictactoe`, `counter`, `notes`) all conform to the
current contract; `npm run smoke` (see below) checks whichever of the first three
is live (`notes` has no smoke check — test it by hand).

## Run / verify

```bash
npm install
npm run typecheck          # tsc --noEmit — must pass
npm run dev                # wrangler dev on :8787
```

Smoke test (server must be running):
```bash
curl -s localhost:8787/api/state
curl -s localhost:8787/preview/            # renders the app page (poker table)
npm run smoke                              # runtime checks for the LIVE app
```
`npm run smoke` (`scripts/smoke.mjs`, no deps — Node 22+ `fetch`/`WebSocket`)
auto-detects the hosted app via `/api/state` and runs the matching checks against
a FRESH room: `counter` (HTTP inc/dec/reset persist), `tictactoe` (seats X/O +
spectator, win/turn/rematch, identical broadcast), `poker` (distinct seats +
per-player `view` hides other hands). To verify ALL three, set
`DEFAULT_TEMPLATE_ID` to each, restart `npm run dev`, and re-run `npm run smoke`.
Multiplayer is over WebSockets, so test it in multiple browser tabs: open the
lobby at http://localhost:8787, **Create room**, then open that room's URL
(`/room.html?room=<id>`, or the "Copy link" button) in more tabs — state syncs
live and each tab is assigned a seat (for `poker`, `P1..P6`; else spectator).
With the default `poker` app, each tab sees only its OWN hole cards — that's the
per-player `view` in action. Press **Edit** in a room to reveal the
Chat/Code/History tools. A second room id stays fully isolated, and bare
`/preview/` still works as room `main`. To test the AI assistant, press **Edit**,
type a request in the **Chat** panel, and watch the tool-call chips + the live
preview update as it edits (each edit becomes a new version).

`dev`, `start`, `deploy`, and `typecheck` are preceded by `build:facet` (an
esbuild step that bundles `src/agent/facet/entry.ts` + tree-shaken dofs into
`src/agent/facet/bundle.generated.ts`), so the facet source is always fresh. Run
`npm run build:facet` manually if you edit the facet outside those commands.

After editing `wrangler.jsonc`, run `npm run types` to regenerate
`worker-configuration.d.ts`.

## Known gotchas

- Preview-grade APIs: `worker_loaders` binding + `@cloudflare/worker-bundler`.
- `worker-bundler` only runs inside workerd (dev/prod), not plain Node — don't
  unit-test it under a Node pool.
- Set `max_tokens` on AI calls or generated code truncates → build errors.
- **`@cloudflare/think` is EXPERIMENTAL** (Session is imported from
  `agents/experimental/memory/session`). It pulls heavy deps (`ai` v6 — pin
  `^6`, NOT v7; `zod` v4; `@cloudflare/shell`; codemode; just-bash), so the
  bundle is large (~5 MB gzip, and this dominates the host bundle). We install the
  minimal set — no React / `@cloudflare/ai-chat` (vanilla client) and Think's
  code-execution/browser/extension tools stay unused. `Think` peer-depends on
  `agents >=0.17.1`, which our pinned `0.17.3` satisfies (no bump needed; vendored
  dofs has no `agents` dep). `CodeAssistant` is a new SQLite DO — its migration is
  `tag: "v2"` in `wrangler.jsonc`.
- **App runtime data lives in a facet (`AppStorageFacet`), not AppHost.** Both the
  key/value store and the dofs filesystem run in the facet's own isolated SQLite;
  AppHost's `store*`/`fs*` methods are thin forwarders. Only the realtime
  `__room__` scope stays in AppHost's `app_data` table. dofs is bundled INTO the
  facet (tree-shaken) so it no longer executes in the host isolate — but the
  ~28 KiB facet source still ships embedded as a string in the host bundle (it
  must, to hand to the Worker Loader), so the host-bundle trim is modest (~30 KB).
  Existing local rooms with pre-facet `app_data` KV won't be seen by the facet —
  use a fresh room id (or clear `.wrangler/`).
- **Dynamic Worker observability via a Tail Worker.** `DynamicWorkerTail`
  (exported from `server.ts`, attached in `runner.ts` via `tails: [...]`) re-emits
  each untrusted app run's `console.log()`/exceptions/outcome into Workers Logs,
  tagged with `workerId`. Requires `observability.head_sampling_rate: 1` in
  `wrangler.jsonc` so nothing is sampled out. A Dynamic Worker's own logs are NOT
  captured without this — they run in a separate context.
- **Line-addressed edits** (`src/author/workers-ai-author.ts`): `applyEdits`
  applies `{path, op, start, end, body}` ops bottom-up (original line numbers stay
  valid), validates bounds/overlap, and throws a clear, model-actionable message
  on a bad op. The assistant's `apply_line_edits` tool passes these ops as a
  structured Zod array (no text parsing) and `read_file` shows 1-indexed line
  numbers so the model can cite exact positions.
- **Self-heal is now the agentic loop.** A tool that writes returns the build
  outcome (`built`/`status`/`error` + `guidance` on failure); if a build fails the
  model reads the error and makes a follow-up edit. There is no separate
  `MAX_AI_REPAIRS` retry loop. Ceiling is still the MODEL: `ASSISTANT_MODEL` must
  be a reliable TOOL-CALLER (pinned `@cf/zai-org/glm-5.2`); weak models may stop
  early, refuse tasks, or emit bad ops.
- **Failed builds don't promote — so the base reverts.** `getFiles`/`read_file`
  return the last GOOD version, not a failed attempt. The failed-build tool result
  says so and steers the model to re-read or use `save_version` (whole file);
  without that, a model iterating on stale line numbers snowballs into corruption.
- **Reasoning-model guards** live in `beforeTurn`: `maxOutputTokens` (avoid the
  `finishReason:"length"` cutoff before an edit is emitted) + `reasoning_effort`
  (`ASSISTANT_REASONING_EFFORT`, default `medium`). `reasoning_effort` goes under
  `providerOptions["workers-ai"]`.
- **Live reload:** `#broadcastReload` (debounced 750 ms) fires only on a
  successful promote; app pages must handle `{type:"reload"}`. Non-realtime apps
  (no WS, e.g. `counter`) can't receive it — reload manually.
- **Player identity is per-tab, in the URL** (`room.html` `?player=`), with a
  `localStorage` fallback in app pages. Old `.wrangler/` rooms may keep the prior
  scheme until reseeded.
- AI/manual output is validated by bundling (`runner.bundleApp`) in `setFiles`
  before going live. Broken versions are saved (not discarded) so they can be
  inspected/rolled back, but they are NOT promoted — the live pointer stays on
  the last version that built and `status` flips to `error`. Auto-promotion
  still happens for any version that builds. (Manual `rollback` may still land
  on a broken version on purpose, for inspection.)
- Local DO state persists in `.wrangler/` across dev restarts.
