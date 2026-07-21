# AGENTS.md — orientation for coding agents

Read `README.md` for the full picture. This file is the fast path + the
invariants you must not break.

## What this is (one line)

A self-modifying app framework: an app's source lives as data in a Durable
Object; each request runs the live version in an isolated Dynamic Worker; edits
(manual or AI) create new versions with no redeploy.

## Hardening status (the `#N` ids used throughout)

Resolved: **#1** state preservation across edits, **#2** atomic KV (`incr`/`cas`),
**#3** app data in a direct-reached top-level `AppData` DO (no AppHost funnel),
**#4** precompiled builds off the request path, **#7** fs/blob/egress/secrets/email/room/scheduler/sql
capabilities (catalog in `capabilities/manifest.ts`),
**#9** template literals allowed (no-backtick rule dropped), **#10** `onUpgrade`
app-data migration, **#12** SSRF-safe mediated egress (manual redirect re-validation
+ response size/timeout caps). Partially resolved: **#5** — per-run
`limits.cpuMs`/`subRequests`, mediated-fetch caps, per-value/per-app store
byte quotas, a daily email cap (`emailPerDay`), a pending-scheduled-tasks cap
(`maxScheduledTasks`), and SQL caps (`sqlMaxRows` per query + `sqlMaxDbBytes`
DB size) are DONE and per-app configurable (`src/config/limits.ts`,
trusted `__limits__` scope, `GET`/`POST /api/limits`); request-rate throttling is
still absent. Outstanding (do NOT assume these are handled): **#6** no auth (rooms are
guessable), **#8** build-gate catches syntax/type errors only (not logic), **#11**
preview-grade APIs + bundle/model ceilings. Full table: README "Hardening status".

**Guardrail principle (applies to all future caps):** every limit ships GENEROUS
by default and per-app configurable. Defaults + clamps live ONLY in
`src/config/limits.ts` (`AppLimits`, `DEFAULT_LIMITS`, `mergeLimits`, `parseLimits`).
Overrides are stored in AppHost's trusted `__limits__` scope (the untrusted app can
never raise its own ceilings) and pushed to `AppData` for local store-quota
enforcement (no hot-path funnel). Add new limit fields there, not inline.

## Where things are

- `src/server.ts` — entry Worker; routes `/api/*` (incl. `/api/egress`,
  `/api/limits`, `/api/secrets`, `/api/email`, and the read-only `/api/resources`
  snapshot for the Resources panel), `/preview/*`, `/agents/*`. `handlePreview`
  runs the app IN the host worker and STREAMS the response. Exports the DOs + all
  capability entrypoints (store, fs, blob, fetch, secrets, email) + `DynamicWorkerTail`.
- `src/agent/app-host.ts` — the Agent (DO). Source of truth for CODE + all
  actions. Persists precompiled builds; holds the egress allowlist; runs the app's
  optional `onUpgrade` data migration on each forward promote (`#runDataUpgrade`,
  tracked in the `__upgrade__` scope — limitation #10); exposes `getRunManifest`/
  `getBuild`/`resolvePrebuilt` for the host-worker run path, and `getResources()`
  (the Resources-panel snapshot: capability catalog from the manifest joined with
  the per-app egress/limits/secrets/email config). It does NOT hold app runtime
  data — that lives in the separate `AppData` DO.
- `src/agent/app-data.ts` — the `AppData` Durable Object: an app's runtime data
  (key/value store + dofs filesystem) in its OWN isolated SQLite, one per room id.
  Reached DIRECTLY by the `ScopedStore`/`ScopedFilesystem` capability stubs (2
  hops, never through AppHost — limitation #3). Bundles the tree-shaken dofs fs
  layer; needs `nodejs_compat` (already enabled worker-wide).
- `src/agent/app-scheduler.ts` — the `AppScheduler` Durable Object: the app's task
  scheduler (`broker.requestScheduler`), one per room id, with its OWN SQLite +
  a single DO alarm. Reached DIRECTLY by the `ScopedScheduler` stub. When a task
  is due its `alarm()` loads the app's live code from AppHost by RPC
  (`getRunManifest`/`getBuild`) and runs the app's `onSchedule(env, ctx)` export in
  the sandbox via `runner.runSchedule` (full `env.SYSTEM`). One-shots are deleted
  after firing; recurring tasks advance (skipping missed slots); the alarm re-arms
  to   the next earliest. Migration `tag: "v4"` in `wrangler.jsonc`.
- `src/agent/app-sql.ts` — the `AppSql` Durable Object: the app's private
  RELATIONAL database (`broker.requestSql`), one per room id, with its OWN SQLite.
  Reached DIRECTLY by the `ScopedSql` stub (limitation #3). A real SQL surface
  (arbitrary schema + queries via `sqlExec(sql, params)` → `{rows, columnNames,
  rowsRead, rowsWritten, lastRowId}`), distinct from AppData's flat key/value
  store. Enforces the trusted caps LOCALLY: a per-query row cap (`sqlMaxRows`) and
  a DB-size soft cap (`sqlMaxDbBytes`, blocks growth writes — INSERT/UPDATE/CREATE/
  ALTER/REPLACE — while allowing SELECT/DELETE/DROP so the app can recover). Caps
  are pushed from `AppHost.setLimits` via `setSqlLimits` and persisted in a
  `__appsql_meta__` table. Migration `tag: "v5"` in `wrangler.jsonc`.
- `src/config/limits.ts` — per-app resource limits (#5): the SINGLE source of
  generous defaults, clamps, and merge/parse. Read by the runner, `ScopedFetcher`,
  `AppData` and `AppSql`. Overrides live in AppHost's `__limits__` scope;
  `AppHost.setLimits` pushes the store caps to `AppData.setStorageLimits` and the
  SQL caps to `AppSql.setSqlLimits`.
- `src/agent/runner.ts` — runs untrusted app code in a Dynamic Worker (injects
  the `SYSTEM` broker, `globalOutbound: null`, per-run `limits` {cpuMs,subRequests},
  attaches the tail worker; uses a persisted build on a cold cache via
  `resolvePrebuilt`). Exposes fetch/reduce/
  initialState/project/seats/probe/migrate/onUpgrade over one injected adapter
  bundle (`onUpgrade` = the app's own store/fs/blob data migration, #10 — it runs
  with `env.SYSTEM`, unlike the pure `migrate`).
- `src/agent/schema.ts` — AppHost's SQLite tables + query helpers (`files`,
  `versions`, `builds`; `app_data` holds the framework `__room__` + `__egress__` +
  `__upgrade__` + `__limits__` + `__secrets__` + `__email__` scopes).
- `src/observability/dynamic-worker-tail.ts` — `DynamicWorkerTail`: captures each
  untrusted app run's logs/exceptions/outcome into Workers Logs, tagged by
  `workerId` (attached in `runner.ts`).
- `src/capabilities/{broker,scoped-store,scoped-sql,scoped-filesystem,scoped-blob-store,scoped-fetcher,scoped-secrets,scoped-email,scoped-room,scoped-scheduler}.ts`
  — capability sandbox. broker mints store/sql/fs/blob/fetch/secrets/email/room/scheduler; store adds
  atomic `incr`/`cas` + JSON helpers; blob is R2-backed; fetcher is mediated egress
  (`send`, allowlist-gated, SSRF-safe per-hop redirect check + size/timeout caps);
  email is mediated transactional send (`send`, sender/recipient policy + daily cap
  checked+reserved on AppHost, then the host-side `EMAIL` binding — app can't spoof
  `From` or exceed `emailPerDay`); room is app-driven realtime (`broadcast`/`send`/
  `presence`) that reaches AppHost's live WS connections by RPC (the app holds no
  socket) and delivers `{type:"app",data}` frames;   scheduler (`after`/`at`/`every`/
  `cancel`/`list`) enqueues tasks in the AppScheduler DO that later run the app's
  `onSchedule` export (capped by `maxScheduledTasks`); sql (`exec`/`query`/`first`/
  `run`) is a private relational database in the per-room AppSql DO (row + DB-size
  caps enforced there).
- `src/capabilities/manifest.ts` — the capability CATALOG and SINGLE source of
  truth (`CapabilityId`, `CAPABILITIES`, `renderCapabilityContract`,
  `KNOWN_CAPABILITY_IDS`, `validateDeclares`). The `declares` vocab, the assistant
  system-prompt contract block, and human docs all derive from it. **When you add
  a capability, add its entry here** — do NOT re-describe it inline in the system
  prompt (the prompt renders from this). Mark reserved ones `available: false`.
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
  so concurrent frames don't race. Pure-reducer path is live. It also exposes a
  public `presence()` for the app-driven Room capability (`broker.requestRoom` →
  `ScopedRoom`), which is now a SECOND consumer of this engine: the app pushes to
  connected clients via AppHost's `appBroadcast`/`appSendToSeat`/`appPresence`
  (reached by RPC), delivered as `{type:"app",data}` frames. On a successful
  promote, `AppHost` also broadcasts a debounced `{type:"reload"}` frame so every
  connected client reloads onto the new code (not just the editor's tab).
- `public/index.html` — the lobby (create/join a room), served at `/`.
- `public/room.html` — the room page (vanilla JS), served at `/room.html?room=<id>`.
  Shows the live app (the game) by default; an **Edit** button reveals the
  editor tools (Run/preview, **Chat**, Code, **Resources**, History). The **Chat**
  panel is a vanilla-JS client for `CodeAssistant`, speaking the Agents chat
  WebSocket protocol (`cf_agent_chat_*`) on `/agents/code-assistant/<room>`. The
  **Resources** panel (the `Resources` module) reads ONE `GET /api/resources`
  snapshot (capability catalog + per-app config) and writes back through the
  existing `POST /api/{limits,egress,secrets,email}` routes, reloading after each
  change — it never talks to the app sandbox, only trusted host config. In edit
  mode it also opens a read-only `?spectate=1` WS to `/agents/app-host/<room>` to
  keep the header status/version live via `cf_agent_state` (see "Live status feed").

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
`requestSql` (a private RELATIONAL SQLite database — `exec`/`query`/`first`/`run`
with `?`-bound params, for tabular/related/aggregated data; row + DB-size capped),
`requestFilesystem` (dofs, ≤256 KiB files), `requestBlobStore` (R2, large
binaries), `requestFetch` (MEDIATED egress — the app sandbox stays
`globalOutbound: null`; `ScopedFetcher.send()` only reaches hosts on the app's
per-app allowlist, held in trusted AppHost storage and set via `POST /api/egress`
or a template's `egress: []`, NEVER by the app; per-hop redirect re-check +
timeout/size caps), and `requestSecrets` (USE-NOT-READ credentials: values live
in AppHost's trusted `__secrets__` scope set via `POST /api/secrets`; the app
INJECTS them host-side via `ScopedFetcher.send`'s `secretHeaders` without ever
reading them, and `requestSecrets().get` returns a raw value ONLY for a secret
flagged `readable`, else throws — `has`/`list` are names-only), and
`requestEmail` (MEDIATED transactional email: `ScopedEmail.send({to,subject,html,
text,cc?,bcc?,replyTo?,from?})` validates the sender/recipients against the room's
policy — trusted `__email__` scope, set via `POST /api/email`, NEVER by the app —
and reserves a slot in the per-day cap `emailPerDay` (`__limits__`) on AppHost
before the host-side `EMAIL` binding sends; the app can't spoof an arbitrary `From`
(omit it for the default sender) or exceed the cap. Reserve-before-send: a failed
send still consumes a slot. Local `wrangler dev` accepts sends as a no-op sink
unless a domain is onboarded + `send_email` binding is `"remote": true`).
And `requestRoom` (APP-DRIVEN realtime — the escape hatch alongside the pure
reducer): `ScopedRoom` gives `broadcast(msg)` / `send(seat, msg)` / `presence()`,
reaching THIS room's live WS connections by RPC into AppHost (the app holds no
socket) and delivering `{type:"app",data}` frames (distinct from the coordinator's
`welcome`/`state`/`reload`). Use it when the update originates OUTSIDE a WS action
(HTTP handler, webhook, scheduled task); keep app-driven state in `requestStore`,
NOT the coordinator's `__room__`.
And `requestScheduler` (deferred/recurring work): `after(seconds,task,payload?)` /
`at(unixMs,...)` / `every(seconds,...)` / `cancel(id)` / `list()`. Tasks live in
the per-room `AppScheduler` DO (own SQLite + alarm); when due it runs the app's
`onSchedule(env, ctx)` export (ctx `{task,payload}`) in the sandbox with full
`env.SYSTEM` — so a task can persist, fetch, email, or broadcast via `requestRoom`.
Pending tasks are capped by `maxScheduledTasks`; delays/intervals floor at 1s.
Any app (realtime or not) may export `onSchedule` to receive these.
And `requestSql` (a private RELATIONAL database): `exec(sql, ...params)` →
`{rows,columnNames,rowsRead,rowsWritten,lastRowId}`, plus conveniences
`query`→rows[], `first`→row|null, `run`→`{rowsWritten,rowsRead,lastRowId}`. Backed
by the per-room `AppSql` DO (its OWN SQLite) — a real SQL surface (define tables,
run arbitrary queries) distinct from `requestStore`'s flat KV. ALWAYS use `?`
placeholders + params (booleans coerce to 0/1). Guardrails enforced in AppSql:
`sqlMaxRows` per query (throws → add LIMIT) + `sqlMaxDbBytes` (blocks growth
writes at the cap, allows SELECT/DELETE/DROP to recover). Reach for SQL over the
flat store whenever data is tabular/related/filtered/sorted/aggregated.
Multiplayer apps additionally export a pure `applyAction(state, action, ctx)` (+ optional
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

## App selection (per-room, runtime)

Each room picks its app AT CREATE TIME from the template catalog (runtime template
selection). The lobby (`public/index.html`) reads `GET /api/templates` (a static
catalog from `registry.listTemplates()` — id/label/declares, NO file bodies) into
a picker, then `POST /api/create?room=<id>` with `{template}` seeds that room from
the chosen template BEFORE navigating to it. `DEFAULT_TEMPLATE_ID` in
`src/templates/registry.ts` (currently `blackjack`) is now only the FALLBACK — used
when a room is reached without a create call (back-compat) or when an unknown
template id is requested.

**Seeding is LAZY, not in `onStart`.** `onStart` is awaited before any RPC, so
seeding there would always pick the default before a caller could choose. Instead
`AppHost.#ensureSeeded(templateId?)` seeds once (guarded by `hasAnyVersion`) and is
called at the top of every entry point (`getStatus`/`getResources`/`getFiles`/
`listVersions`/`getRunManifest`/`preview`/`resetToTemplate`/`onConnect`). The
public `create(templateId?)` is what the lobby calls — it seeds the CHOSEN template
and is idempotent (an existing room is returned unchanged, `created:false`, NEVER
re-seeded). Any other first-touch seeds the default. A room already in `.wrangler/`
keeps its seeded code — use a fresh room id (or clear `.wrangler/`).

The five example apps (`blackjack`, `poker`, `tictactoe`, `counter`, `notes`) all
conform to the current contract; `npm run smoke` (see below) auto-detects a room's
app via `/api/state` and covers `counter`, `tictactoe` and `poker` (`blackjack` and
`notes` have no smoke check — test them by hand). To smoke a specific app, create a
room with it (`POST /api/create?room=<id>` `{template}`) and point the smoke script
at that room.

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
CREATES a fresh room seeded with the app you pass (`POST /api/create`), then runs
the matching checks: `npm run smoke -- counter` (HTTP inc/dec/reset persist),
`-- tictactoe` (seats X/O + spectator, win/turn/rematch, identical broadcast),
`-- poker` (distinct seats + per-player `view` hides other hands). Thanks to
runtime template selection you can smoke ALL three against ONE running dev server —
no restart needed (a base URL and the app name can be passed in any order:
`npm run smoke -- poker http://localhost:8788`). With no app name a fresh room
seeds the default (blackjack), which has no suite.
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
- **Secrets (`capabilities/scoped-secrets.ts`, #2.1).** USE-NOT-READ credentials.
  Values live in AppHost's trusted `__secrets__` scope (`{ v, r }` per name), set
  ONLY via `POST /api/secrets` (`setSecret`/`deleteSecret`) — never by the app,
  never returned over the wire (`/api/secrets` GET + `listSecrets` are names +
  `readable` flag only). `AppHost.resolveSecret(name, { requireReadable? })` is the
  TRUSTED resolver: capability stubs call it (reachable only host-side, not by the
  app). `ScopedFetcher` injects `secretHeaders` WITHOUT `requireReadable` (value
  never enters the sandbox; stripped on redirect so creds don't follow to another
  host); `ScopedSecrets.get` calls it WITH `requireReadable` (raw read only for a
  secret flagged `readable`). No new binding — pure DO storage.
- **Email (`capabilities/scoped-email.ts`, #2.2).** MEDIATED transactional email.
  Policy lives in AppHost's trusted `__email__` scope (`allowedFrom`,
  `allowRecipients`, `defaultFrom`, `fromName`), set ONLY via `POST /api/email`
  (`setEmailPolicy`) — never by the app. `AppHost.reserveEmail({from?,recipients})`
  is the TRUSTED gate: it resolves+validates the sender (must be in `allowedFrom`;
  omitted ⇒ `defaultFrom`/first), checks each recipient against `allowRecipients`
  (empty ⇒ allow any; entries are exact `a@b.com`, domain `b.com`, or `*.b.com`),
  and RESERVES one slot in the daily counter (`sent:YYYY-MM-DD` in `__email__`,
  capped by `emailPerDay` from `__limits__`) — all SYNC DO storage, so it's
  serialized on the input gate and can't overspend under concurrency. The slow
  `env.EMAIL.send()` runs in the STUB (host worker), NOT the DO, so it never holds
  the gate (limitation #3). Reserve-before-send ⇒ a failed network send still
  consumes a slot (intentional: bounds retry storms). The app never sees the
  `EMAIL` binding; `ScopedEmail.send()` is the only surface. `send_email` binding
  in `wrangler.jsonc` uses `name` (not `binding`); local dev accepts sends as a
  no-op sink (real sending needs an onboarded domain + `"remote": true`).
- **App-driven realtime (`capabilities/scoped-room.ts`, #2.3).** The SECOND
  consumer of the realtime engine, alongside the pure reducer. The app is a pure
  per-request function and holds NO socket; `ScopedRoom` reaches the room's live
  WS connections by RPC into AppHost (`appBroadcast`/`appSendToSeat`/`appPresence`)
  — the sockets live in AppHost, the DO. Delivers each message as
  `{type:"app",data}` (never collides with the coordinator's `welcome`/`state`/
  `reload`); editor spectators (`SPECTATOR_TOKEN`) are always excluded. Presence
  comes from `RoomCoordinator.presence()` (seat pool + who's connected). By design
  it does NOT expose the coordinator's `__room__` state — app-driven apps keep
  their own state in `requestStore`, so the two state models never race. No new
  binding — pure DO RPC. The app's client connects a WS to
  `/agents/app-host/<room>?token=<id>` and handles the `{type:"app"}` frame.
- **Scheduler (`capabilities/scoped-scheduler.ts` + `agent/app-scheduler.ts`, #2.4).**
  Deferred/recurring work. `ScopedScheduler` (after/at/every/cancel/list) reaches
  the per-room `AppScheduler` DO DIRECTLY (`env.APP_SCHEDULER.idFromName(instance)`,
  like AppData — limitation #3). AppScheduler holds tasks in its OWN SQLite and a
  single DO ALARM armed to the earliest task; `alarm()` mutates the table FIRST
  (advance recurring / delete one-shots) THEN runs each due task, so a slow/failing
  task is never re-fired in the same pass. It loads the app's live code from AppHost
  by RPC (`getRunManifest`/`getBuild`) and runs `onSchedule(env, ctx)` via
  `runner.runSchedule` — SAME sandbox as fetch (only `env.SYSTEM`), so a task can
  broadcast via `requestRoom`, persist, fetch, email. AppScheduler persists the
  `instance` (room id) in a `sched_meta` row on first schedule, since the alarm has
  no caller to supply it. Guardrails: `maxScheduledTasks` (trusted limit, enforced
  atomically in the DO) + a hardcoded 1s delay/interval floor (`MIN_DELAY_MS`) to
  stop alarm storms. NOTE: `sql.exec<T>` needs a `type` alias (an `interface` fails
  the `Record<string, SqlStorageValue>` constraint). No new store scope — it's a
  separate DO. New binding `APP_SCHEDULER` + migration `tag: "v4"` in wrangler.
- **SQL (`capabilities/scoped-sql.ts` + `agent/app-sql.ts`, #2.5).** A private
  RELATIONAL database, distinct from `requestStore`'s flat KV. `ScopedSql`
  (`exec`/`query`/`first`/`run`) reaches the per-room `AppSql` DO DIRECTLY
  (`env.APP_SQL.idFromName(instance)`, like AppData/AppScheduler — limitation #3),
  which owns its SQLite. Guardrails live IN AppSql (no per-query RPC to AppHost):
  the caps are PUSHED once from `AppHost.setLimits` via `setSqlLimits` (persisted
  in a `__appsql_meta__` row, defaulting to `DEFAULT_LIMITS`), then enforced
  locally — `sqlMaxRows` throws if a result exceeds the cap ("add LIMIT"), and
  `sqlMaxDbBytes` blocks GROWTH writes (INSERT/UPDATE/CREATE/ALTER/REPLACE, by a
  leading-keyword heuristic) once `ctx.storage.sql.databaseSize >= cap`, while
  SELECT/DELETE/DROP/PRAGMA stay allowed so the app can recover. `ScopedSql`
  coerces boolean params → 0/1; `lastRowId` is computed (via `last_insert_rowid()`)
  ONLY when `rowsWritten > 0`. Trusted tenants: an app may run arbitrary SQL/DDL
  against its OWN db — we do NOT block `sqlite_*`/`_cf_*` tables (the platform
  already blocks internal writes; isolation is by DO, not by SQL parsing).
  `sql.exec<T>` needs a `type` alias for the row type (an `interface` fails the
  `Record<string, SqlStorageValue>` constraint). New binding `APP_SQL` + migration
  `tag: "v5"` in wrangler. `AppHost.setLimits` now pushes to BOTH AppData
  (store caps) and AppSql (sql caps).
- **New capability files:** `capabilities/scoped-blob-store.ts` (R2, keyed by
  `<instance>/<namespace>/`), `capabilities/scoped-fetcher.ts` (mediated egress,
  method is `send` not `fetch` to avoid the WorkerEntrypoint collision),
  `capabilities/scoped-secrets.ts` (secrets, above), `capabilities/scoped-email.ts`
  (email, above), `capabilities/scoped-room.ts` (app-driven realtime, above),
  `capabilities/scoped-scheduler.ts` (scheduler, above),
  `capabilities/scoped-sql.ts` (SQL, above). All are
  exported from `server.ts` and minted by the broker. R2 binding `BLOBS` is in
  `wrangler.jsonc` (`r2_buckets`); after adding it, `npm run types` regenerates a
  STRICTER d.ts (pins `ASSISTANT_MODEL` to a literal + retypes stubs) that breaks
  `tsc` — the committed `worker-configuration.d.ts` is hand-kept with
  `ASSISTANT_MODEL: string`; add new bindings by hand rather than clobbering it
  (the `send_email` `SendEmail` binding was added by hand under `__BaseEnv_Env`).
- Local DO state persists in `.wrangler/` across dev restarts.
