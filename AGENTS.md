# AGENTS.md — orientation for coding agents

Read `README.md` for the full picture. This file is the fast path + the
invariants you must not break.

## What this is (one line)

A self-modifying app framework: an app's source lives as data in a Durable
Object; each request runs the live version in an isolated Dynamic Worker; edits
(manual or AI) create new versions with no redeploy.

## Where things are

- `src/server.ts` — entry Worker; routes `/api/*` (incl. `/api/egress`),
  `/preview/*`, `/agents/*`. `handlePreview` runs the app IN the host worker and
  STREAMS the response. Exports the DOs + all capability entrypoints (store, fs,
  blob, fetch) + `DynamicWorkerTail`.
- `src/agent/app-host.ts` — the Agent (DO). Source of truth for CODE + all
  actions. Persists precompiled builds; holds the egress allowlist; runs the app's
  optional `onUpgrade` data migration on each forward promote (`#runDataUpgrade`,
  tracked in the `__upgrade__` scope — limitation #10); exposes `getRunManifest`/
  `getBuild`/`resolvePrebuilt` for the host-worker run path. It does NOT hold app
  runtime data — that lives in the separate `AppData` DO.
- `src/agent/app-data.ts` — the `AppData` Durable Object: an app's runtime data
  (key/value store + dofs filesystem) in its OWN isolated SQLite, one per room id.
  Reached DIRECTLY by the `ScopedStore`/`ScopedFilesystem` capability stubs (2
  hops, never through AppHost — limitation #3). Bundles the tree-shaken dofs fs
  layer; needs `nodejs_compat` (already enabled worker-wide).
- `src/agent/runner.ts` — runs untrusted app code in a Dynamic Worker (injects
  the `SYSTEM` broker, `globalOutbound: null`, attaches the tail worker; uses a
  persisted build on a cold cache via `resolvePrebuilt`). Exposes fetch/reduce/
  initialState/project/seats/probe/migrate/onUpgrade over one injected adapter
  bundle (`onUpgrade` = the app's own store/fs/blob data migration, #10 — it runs
  with `env.SYSTEM`, unlike the pure `migrate`).
- `src/agent/schema.ts` — AppHost's SQLite tables + query helpers (`files`,
  `versions`, `builds`; `app_data` holds the framework `__room__` + `__egress__` +
  `__upgrade__` scopes).
- `src/observability/dynamic-worker-tail.ts` — `DynamicWorkerTail`: captures each
  untrusted app run's logs/exceptions/outcome into Workers Logs, tagged by
  `workerId` (attached in `runner.ts`).
- `src/capabilities/{broker,scoped-store,scoped-filesystem,scoped-blob-store,scoped-fetcher}.ts`
  — capability sandbox. broker mints store/fs/blob/fetch; store adds atomic
  `incr`/`cas` + JSON helpers; blob is R2-backed; fetcher is mediated egress
  (`send`, allowlist-gated).
- `src/assistant/code-assistant.ts` — the AI coding assistant, a SEPARATE Durable
  Object `CodeAssistant extends Think` (`@cloudflare/think`). One per room, keyed
  by the room id. Runs the agentic loop (model calls host-side tools → reads
  results → loops) with per-room memory (Session context block). Its tools reach
  the room's `AppHost` by RPC (`getAgentByName`) and edit code ONLY through
  `AppHost.setFiles` (build-gated). This is now the primary AI-edit path.
- `src/author/*` — the line-edit engine (`parseEdits`/`applyEdits`/`FileEdit`)
  reused by the assistant's `apply_line_edits` tool. `WorkersAiAuthor` (the old
  one-shot `CodeAuthor`) is retained but no longer wired to `AppHost`.
- `src/templates/types.ts` — the app contract. `examples/blackjack.ts` (realtime +
  hidden information; the DEFAULT seed), `examples/poker.ts` (realtime + hidden
  information), `examples/tictactoe.ts` (realtime), `examples/counter.ts`
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
  protocol (`cf_agent_chat_*`) on `/agents/code-assistant/<room>`. In edit mode it
  also opens a read-only `?spectate=1` WS to `/agents/app-host/<room>` to keep the
  header status/version live via `cf_agent_state` (see "Live status feed" below).

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
6. **Lifecycle methods aren't RPC-callable** on the Agents stub. Keep host↔agent
   calls as explicit public methods (e.g. `getRunManifest`/`getBuild`/`setFiles`),
   not `onRequest`. The user-facing `/preview/*` path fetches CODE via
   `AppHost.getRunManifest()` and runs the app in the HOST worker so the response
   can stream (see server.ts); the buffered `AppHost.preview()` method remains
   ONLY for the assistant's `preview` tool (returns serializable data). (WebSocket
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

10. **App runtime data lives in a dedicated top-level `AppData` DO, still behind
    the broker (limitation #3).** An app's own store (`requestStore`) and
    filesystem (`requestFilesystem`) are backed by the `AppData` Durable Object
    (`src/agent/app-data.ts`) — its OWN isolated SQLite, keyed by room id. The
    `ScopedStore`/`ScopedFilesystem` stubs reach it DIRECTLY
    (`env.APP_DATA.get(idFromName(instance))`) — TWO hops, never through AppHost.
    AppHost only holds CODE (plus the realtime `__room__` and egress `__egress__`
    scopes). This changes WHERE the bytes live AND removes AppHost from the storage
    hot path — but NOT the security model: the untrusted app still can't touch the
    DO directly; the broker's scoped stubs validate/quota/sanitise every call. The
    DO adds isolation; the broker keeps policy. The class is TRUSTED framework code,
    bundled normally (no Worker Loader), and needs `nodejs_compat` (dofs uses
    `node:crypto`/`node:events`), which the worker already enables. This was
    formerly a Durable Object FACET beneath AppHost; it was promoted to a top-level
    DO to drop the forced parent hop — see docs/cloudflare-sdk-usage.md ("History:
    first a Facet, then a top-level DO"). NEVER route app storage back through
    AppHost.

11. **The Code Mode sandbox gets ONLY tool dispatchers — never a binding.** The
    assistant's `code_mode` tool (`@cloudflare/codemode`, wired in
    `CodeAssistant.getTools`) lets the model write ONE orchestration script that
    runs in its OWN Dynamic Worker via `DynamicWorkerExecutor`. That executor is
    constructed with `{ loader: this.env.LOADER }` ONLY: `globalOutbound` stays at
    its default `null` (no egress), and NO `env`/`bindings` are passed. The script
    reaches the host solely through Workers RPC to the curated
    `CODE_MODE_SANDBOX_TOOLS` (read/edit tools — NOT `rollback`/`reset_app`, NOT
    `code_mode` itself). Those tool `execute` bodies run host-side and still write
    through `AppHost.setFiles` (the build-gate). So Code Mode adds a SECOND sandbox
    for the assistant's ORCHESTRATION; the untrusted-app sandbox (`runner.ts`) and
    the promote path are unchanged. NEVER feed Think's workspace/state tools (or
    any binding-backed provider) into `createCodeTool` — that would hand the
    sandbox a filesystem/resource it must not have. This is why we use
    `@cloudflare/codemode` directly rather than Think's workspace-coupled helpers.

## The runtime contract apps must follow

Default export `fetch(request, env)`; HTML page at `/`; persist via
`env.SYSTEM.requestStore(...)`; relative URLs in HTML. **Capabilities today:**
`requestStore` (KV — incl. ATOMIC `incr`/`cas` and JSON `putJSON`/`getJSON`),
`requestFilesystem` (dofs, ≤256 KiB files), `requestBlobStore` (R2, large
binaries), and `requestFetch` (MEDIATED egress — the app sandbox stays
`globalOutbound: null`; `ScopedFetcher.send()` only reaches hosts on the app's
per-app allowlist, held in trusted AppHost storage and set via `POST /api/egress`
or a template's `egress: []`, NEVER by the app). Multiplayer
apps additionally export a pure `applyAction(state, action, ctx)` (+ optional
`initialState`, `seats`, and `view(state, ctx)` for hidden information) and
connect a WebSocket to `/agents/app-host/<room>?token=<id>` (the room read from
the page's own `location`, default `main`). The realtime client MUST also handle
the reserved `{type:"reload"}` frame (`location.reload()`) so it picks up new code
after an edit, and should derive its `token` so identity is stable across
reload/reopen (see Player identity below). Any app (realtime or not) may also
export an optional `onUpgrade(env, ctx)` to migrate its OWN persisted data across
a code change (#10 — see gotchas). See `src/templates/types.ts` and the
assistant's system prompt in `src/assistant/code-assistant.ts` (keep the two in
sync — that prompt is what the AI reads when writing app code).

### Live reload + player identity

- **Live reload:** `AppHost.setFiles` (and `rollback`) broadcast `{type:"reload"}`
  to all connected clients when a version is PROMOTED (build succeeded), debounced
  by `RELOAD_DEBOUNCE_SECONDS` (0.75 s) so a multi-promote turn = one reload; a
  failed build never reloads. The debounce is backed by a DO alarm
  (`this.schedule(..., "flushReload", ...)`), not `setTimeout`, so it survives
  hibernation. App pages opt in by handling the frame.
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
There is also a `code_mode` tool (Code Mode, `@cloudflare/codemode`): the model
writes ONE async arrow function that orchestrates the read/edit tools in a single
step (fewer round-trips) for MECHANICAL multi-step work — it runs isolated in its
own Dynamic Worker (no egress, no bindings; see invariant #11) and cannot reason
between steps, so it complements — not replaces — the individual tools.
Every write goes through `AppHost.setFiles`, so the build-gate + version history
are unchanged: broken code is saved-not-promoted, good code auto-promotes. The
loop reading a returned build error and fixing it IS the self-heal (no separate
repair loop) — the failed-build tool result also tells the model the base
reverted (not promoted), steering it to re-read or switch to `save_version`.
Per-room memory is a writable Session context block (`set_context`). Model set via
`ASSISTANT_MODEL` — **pinned to `@cf/moonshotai/kimi-k2.7-code`** in `wrangler.jsonc`
`vars` (Moonshot's 1T-param agentic coding model, 262k context; same id is the
hardcoded fallback); it must be a reliable tool-caller.
Reasoning models get `beforeTurn` guards: a large `maxOutputTokens` (so reasoning
can't crowd out the tool call) and `reasoning_effort` (default `medium`, tunable
via `ASSISTANT_REASONING_EFFORT`). There is no `/api/edit` HTTP route anymore.

## One app at a time

This framework hosts ONE app. The hosted app is chosen by the SINGLE constant
`DEFAULT_TEMPLATE_ID` in `src/templates/registry.ts` (currently `blackjack`);
`AppHost.initialState.templateId` derives from it. Every room seeds from it. To
build a different app, change that one line (e.g. `"poker"` or `"counter"`)
and/or the template's files. Note: a room already in `.wrangler/` keeps its
seeded code — use a fresh room id (or clear `.wrangler/`) after switching. The
five example apps (`blackjack`, `poker`, `tictactoe`, `counter`, `notes`) all
conform to the current contract; `npm run smoke` (see below) covers `counter`,
`tictactoe` and `poker` (`blackjack` and `notes` have no smoke check — test them
by hand).

## Run / verify

```bash
npm install
npm run typecheck          # tsc --noEmit — must pass
npm run dev                # wrangler dev on :8787
```

Smoke test (server must be running):
```bash
curl -s localhost:8787/api/state
curl -s localhost:8787/preview/            # renders the app page (blackjack table)
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
live and each tab is assigned a seat (for `blackjack`, `P1..P5`; else spectator).
With the default `blackjack` app, the dealer's hole card stays hidden until the
dealer plays — that's the per-player `view` in action. Press **Edit** in a room to reveal the
Chat/Code/History tools. A second room id stays fully isolated, and bare
`/preview/` still works as room `main`. To test the AI assistant, press **Edit**,
type a request in the **Chat** panel, and watch the tool-call chips + the live
preview update as it edits (each edit becomes a new version).

The `AppData` DO (app runtime store + dofs filesystem) is bundled normally by
wrangler — there is no separate build step (the old `build:facet` prebuild was
removed when app data moved from a facet to a top-level DO).

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
  bundle is sizeable (measured ~1.46 MB gzip for the whole host worker — WELL
  under the 3 MB Free / 10 MB paid script-size limits; the earlier "~5 MB gzip"
  note was the un-tree-shaken on-disk dep size, not the built bundle). Think
  dominates the bundle's COMPOSITION and cold-start parse cost, not the size
  ceiling. If that parse cost ever matters, split CodeAssistant into its own
  Worker service so the app-serving worker stays lean. We install the
  minimal set — no React / `@cloudflare/ai-chat` (vanilla client) and Think's
  workspace/bash/extension tools stay gated OFF (`workspaceBash = false` +
  `beforeTurn` `activeTools`). `Think` peer-depends on `agents >=0.17.1`, which our
  pinned `0.17.3` satisfies (no bump needed; vendored dofs has no `agents` dep).
  `CodeAssistant` is a new SQLite DO — its migration is `tag: "v2"` in
  `wrangler.jsonc`.
- **Code Mode is used directly, not via Think.** `@cloudflare/codemode` (already
  in the tree as a Think transitive dep, now pinned explicitly in `package.json`)
  powers the assistant's `code_mode` tool. We import `createCodeTool`/`aiTools`
  from `@cloudflare/codemode/ai` and `DynamicWorkerExecutor` from
  `@cloudflare/codemode` DIRECTLY — NOT Think's `./tools/execute` (which 0.13
  doesn't export, and which couples to Think's workspace). Direct use lets us pass
  ONLY the curated `CODE_MODE_SANDBOX_TOOLS` into the sandbox and keep
  `globalOutbound: null` (invariant #11). No new binding is needed — it reuses the
  existing `LOADER`.
- **App runtime data lives in the `AppData` DO, not AppHost (limitation #3).**
  Both the key/value store and the dofs filesystem run in `AppData`'s own isolated
  SQLite (`src/agent/app-data.ts`), reached DIRECTLY by the ScopedStore/
  ScopedFilesystem stubs (`env.APP_DATA.get(idFromName(instance))`) — two hops,
  never through AppHost. Only the realtime `__room__` and egress `__egress__`
  scopes stay in AppHost's `app_data` table. dofs is bundled normally and executes
  only in the `AppData` DO's isolate. This replaced an earlier `AppStorageFacet`
  facet (reached via `AppHost.ctx.facets.get`, 3 hops); the facet + its
  `build:facet` step are gone. `AppData` is a new SQLite DO — migration `tag: "v3"`
  in `wrangler.jsonc`. Existing local rooms won't carry data across the cutover —
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
  be a reliable TOOL-CALLER (pinned `@cf/moonshotai/kimi-k2.7-code`); weak models
  may stop early, refuse tasks, or emit bad ops.
- **Failed builds don't promote — so the base reverts.** `getFiles`/`read_file`
  return the last GOOD version, not a failed attempt. The failed-build tool result
  says so and steers the model to re-read or use `save_version` (whole file);
  without that, a model iterating on stale line numbers snowballs into corruption.
 - **Reasoning-model guards** live in `beforeTurn`: `maxOutputTokens` (avoid the
   `finishReason:"length"` cutoff before an edit is emitted) + `reasoning_effort`
   (`ASSISTANT_REASONING_EFFORT`, default `medium`). `reasoning_effort` goes under
   `providerOptions["workers-ai"]`.
 - **Context management uses Think's built-ins, not a hand-rolled pass.** There is
   no longer a `beforeStep` clipping hook. Long/tool-heavy transcripts are kept in
   check by (1) DETERMINISTIC compaction registered in `configureSession`
   (`onCompaction(createCompactFunction({ summarize: () => COMPACTION_SUMMARY }))`
   + `compactAfter(CONTEXT_TOKEN_BUDGET)`) — the `summarize` returns a fixed
   re-read marker so it costs no model call and can never no-op; (2)
   `this.contextOverflow` (proactive compaction before overflow + a reactive
   compact-and-retry backstop, keyed off `classifyChatError =
   defaultContextOverflowClassifier`); (3) `this.mediaEviction` (drops big aged
   tool-output blobs from durable storage); and (4) `this.chatRecovery` (durable
   fiber so a deploy/eviction/stall mid-turn resumes instead of stalling). These
   are all TRANSCRIPT-level (the assistant's own Session/DO SQLite) — they never
   touch app files or the app sandbox, so they don't affect isolation. Compaction
   relies on the app being re-readable: the system prompt already tells the model
   to re-read files, which the compaction marker reinforces.
- **Live reload:** `#broadcastReload` (debounced `RELOAD_DEBOUNCE_SECONDS` =
  0.75 s) fires only on a successful promote; app pages must handle
  `{type:"reload"}`. Non-realtime apps (no WS, e.g. `counter`) can't receive it —
  reload manually. The debounce is backed by a Durable Object ALARM
  (`this.schedule(RELOAD_DEBOUNCE_SECONDS, "flushReload", {version})`), NOT
  `setTimeout`: a plain timer is lost if the DO hibernates during the window,
  silently dropping the reload; the alarm survives hibernation. Each new promote
  `cancelSchedule`s the pending one and re-arms (coalescing a burst into one
  reload). `flushReload` is a public (non-`#private`) callback because the Agent
  scheduler invokes it by key.
- **Version-history GC** runs on a recurring alarm: `onStart` calls
  `this.scheduleEvery(VERSION_GC_INTERVAL_SECONDS, "gcVersions")` (idempotent, so
  one schedule survives every DO wake). `gcVersions` calls `db.pruneVersions`,
  which keeps the newest `VERSION_HISTORY_KEEP` (50) versions PLUS the active one
  and deletes the rest from `files`+`versions` — so history can't grow unbounded.
- **Live status feed (editor chrome):** `room.html` opens a READ-ONLY WS to
  `/agents/app-host/<room>?spectate=1` to watch AppHost's synced state via the
  Agents `cf_agent_state` protocol (initial frame on connect + a frame on every
  `setState`), keeping the editor header live when the version changes without a
  local action (assistant promote, another tab's edit). `?spectate=1` makes
  `AppHost.onConnect` SKIP the coordinator (tagging the connection with
  `SPECTATOR_TOKEN`), so the editor takes NO game seat and is filtered out of game
  broadcasts/presence (`#roomHost().roomConnections`). The on-load `/api/state`
  fetch stays as the fallback.
- **Player identity is per-tab, in the URL** (`room.html` `?player=`), with a
  `localStorage` fallback in app pages. Old `.wrangler/` rooms may keep the prior
  scheme until reseeded.
- AI/manual output is validated by bundling (`runner.bundleApp`) in `setFiles`
  before going live. Broken versions are saved (not discarded) so they can be
  inspected/rolled back, but they are NOT promoted — the live pointer stays on
  the last version that built and `status` flips to `error`. Auto-promotion
  still happens for any version that builds. (Manual `rollback` may still land
  on a broken version on purpose, for inspection.)
 - **State preservation across edits (#1).** A code edit no longer auto-wipes
   realtime state. `coordinator.#ensureFreshState` runs KEEP → MIGRATE → RESET:
   it probes the old state against the new bundle (via the sandboxed `probe` in
   `runner.ts`, which exercises the app's `view`/`initialState`), keeps it if
   compatible, else runs the app's optional pure `migrate(old, oldVersion)` and
   keeps that if it re-probes ok, else reseeds `initialState` + clears seats. Keep
   any existing `migrate`/`stateVersion` exports when editing an app.
 - **App-data upgrades (#10).** `migrate` (#1) only reshapes the realtime
   `__room__` state. The app's OWN data (store/fs/blob) is migrated by an optional
   `onUpgrade(env, ctx)` export — NOT pure: it gets the same `env` as `fetch`
   (`env.SYSTEM`), so it reads/rewrites that data. `AppHost.#runDataUpgrade` runs
   it via `runner.runUpgrade` ONCE per FORWARD promote (right after the build
   passes + the pointer advances), tracking the last-upgraded version in the
   `__upgrade__` app_data scope; it is skipped on rollback and on the first seed
   (fresh data). It must be IDEMPOTENT (guard on current shape) since it runs every
   forward promote. If it throws, the code STAYS promoted but `status` flips to
   `error` and the `__upgrade__` pointer is NOT advanced, so the next promote
   retries from the same base. Keep any existing `onUpgrade` when editing an app.
- **Precompiled builds (#4).** `setFiles`/seed persist the bundler output keyed
  by content hash (`schema.builds`). The runner (`loadWorker`) uses it on a COLD
  Worker Loader cache instead of re-running esbuild; `resolvePrebuilt` is only
  consulted inside the cold-cache callback, so warm hits are free. `getBuild` is
  the RPC the host worker passes as the resolver. Pruned in `gcVersions`.
- **Streaming run path (#3d/#7).** The user-facing `/preview/*` runs the app in
  the HOST worker (`server.ts handlePreview` via `AppHost.getRunManifest()` +
  `runner.runApp`) and STREAMS the response; HTML `<base>` is injected with
  HTMLRewriter (also streaming). This keeps the HTTP data path off the DO and
  enables SSE/large bodies. `AppHost.preview()` (buffered) still exists for the
  assistant's `preview` tool ONLY.
- **New capability files:** `capabilities/scoped-blob-store.ts` (R2, keyed by
  `<instance>/<namespace>/`), `capabilities/scoped-fetcher.ts` (mediated egress,
  method is `send` not `fetch` to avoid the WorkerEntrypoint collision). Both are
  exported from `server.ts` and minted by the broker. R2 binding `BLOBS` is in
  `wrangler.jsonc` (`r2_buckets`); after adding it, `npm run types` regenerates a
  STRICTER d.ts (pins `ASSISTANT_MODEL` to a literal + retypes stubs) that breaks
  `tsc` — the committed `worker-configuration.d.ts` is hand-kept with
  `ASSISTANT_MODEL: string`; add new bindings by hand rather than clobbering it.
- Local DO state persists in `.wrangler/` across dev restarts.
