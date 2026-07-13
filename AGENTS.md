# AGENTS.md — orientation for coding agents

Read `README.md` for the full picture. This file is the fast path + the
invariants you must not break.

## What this is (one line)

A self-modifying app framework: an app's source lives as data in a Durable
Object; each request runs the live version in an isolated Dynamic Worker; edits
(manual or AI) create new versions with no redeploy.

## Where things are

- `src/server.ts` — entry Worker; routes `/api/*`, `/preview/*`, `/agents/*`.
- `src/agent/app-host.ts` — the Agent (DO). Source of truth + all actions.
- `src/agent/runner.ts` — runs untrusted app code in a Dynamic Worker.
- `src/agent/schema.ts` — SQLite tables + query helpers.
- `src/capabilities/{broker,scoped-store}.ts` — capability sandbox.
- `src/author/*` — swappable AI code editor (`CodeAuthor`).
- `src/templates/types.ts` — the app contract. `examples/poker.ts` (realtime +
  hidden information), `examples/tictactoe.ts` (realtime) and
  `examples/counter.ts` = example apps.
- `src/realtime/coordinator.ts` — the realtime engine (WS/presence/seats/
  per-player broadcast) that drives the app's pure `applyAction` reducer and
  optional `view` projection. State transitions are serialized (a promise chain)
  so concurrent frames don't race. Pure-reducer path is live; `broker.requestRoom`
  (app-driven realtime) is still a reserved future consumer.
- `public/index.html` — the lobby (create/join a room), served at `/`.
- `public/room.html` — the room page (vanilla JS), served at `/room.html?room=<id>`.
  Shows the live app (the game) by default; an **Edit** button reveals the
  editor tools (Run/preview, Ask AI, Code, History).

## Multi-room

Each room is an isolated app instance = one `AppHost` Durable Object, keyed by
its id via `getAgentByName(env.AppHost, roomId)`. Per room: its own code,
version history and realtime state. The room id comes from the `?room=` query
param on `/api/*` and `/preview/*` (sanitized to `[A-Za-z0-9_-]`, cap 64), and
is the DO name on the `/agents/app-host/<room>` WS route. Missing/invalid =>
`main` (back-compat). The served page self-locates its room from its own
`location` (`?room=`), so the same HTML works in any room.

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
   `CodeAuthor` / the runtime contract — never concrete app content. Example
   apps live under `src/templates/examples/`.
5. **Lifecycle methods aren't RPC-callable** on the Agents stub. Preview runs via
   the custom `AppHost.preview()` method (returns serializable data), not
   `onRequest`. Keep host↔agent calls as explicit public methods. (WebSocket
   lifecycle — `onConnect`/`onMessage`/`onClose` — is the exception: it's invoked
   by `routeAgentRequest`, and delegates to the realtime coordinator.)
6. **Realtime apps stay pure.** The untrusted app NEVER holds a socket or does
   I/O for multiplayer. It exports pure functions only — `applyAction(state,
   action, ctx)` (+ optional `initialState`, `view`, `seats`); the trusted
   coordinator owns the WebSockets, presence/seats, persistence and broadcast,
   and invokes them in the sandbox via `runner.reduce()` / `runner.project()` /
   `runner.seats()`. The reducer is side-effect-free but `Math.random()` IS
   allowed (its result is persisted as the next state — e.g. shuffling a deck).
   Realtime state lives in `app_data` under the reserved `__room__` scope — never
   in `this.setState` (invariant #3).

7. **Seats are app-defined; the core names none.** Seat labels come from the
   app's optional `seats` export (e.g. `["X","O"]`, `["P1".."P6"]`). No `seats`
   export ⇒ everyone is a spectator (`ctx.seat === null`).

8. **Asymmetric views go through `view`, not the reducer.** For hidden
   information (poker hands, etc.) the reducer keeps ONE full authoritative
   state; an optional pure `view(state, ctx)` projects the slice each viewer may
   see. The coordinator projects per connection (batched) and sends each client
   its own frame. No `view` export ⇒ the full state is broadcast to everyone
   (symmetric apps like tic-tac-toe, unchanged). NEVER put secrets only in the
   reducer's broadcast path — redact them in `view`.

## The runtime contract apps must follow

Default export `fetch(request, env)`; HTML page at `/`; persist via
`env.SYSTEM.requestStore(...)`; no network; relative URLs in HTML. Multiplayer
apps additionally export a pure `applyAction(state, action, ctx)` (+ optional
`initialState`, `seats`, and `view(state, ctx)` for hidden information) and
connect a WebSocket to `/agents/app-host/<room>` (the room read from the page's
own `location`, default `main`). See `src/templates/types.ts` and the author's
system prompt in `src/author/workers-ai-author.ts` (keep the two in sync).

## One app at a time

This framework hosts ONE app. The hosted app is chosen by the SINGLE constant
`DEFAULT_TEMPLATE_ID` in `src/templates/registry.ts` (currently `poker`);
`AppHost.initialState.templateId` derives from it. Every room seeds from it. To
build a different app, change that one line (e.g. `"tictactoe"` or `"counter"`)
and/or the template's files. Note: a room already in `.wrangler/` keeps its
seeded code — use a fresh room id (or clear `.wrangler/`) after switching. The
three example apps (`poker`, `tictactoe`, `counter`) all conform to the current
contract; `npm run smoke` (see below) checks whichever one is live.

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
code/AI/history tools. A second room id stays fully isolated, and bare
`/preview/` still works as room `main`.

After editing `wrangler.jsonc`, run `npm run types` to regenerate
`worker-configuration.d.ts`.

## Known gotchas

- Preview-grade APIs: `worker_loaders` binding + `@cloudflare/worker-bundler`.
- `worker-bundler` only runs inside workerd (dev/prod), not plain Node — don't
  unit-test it under a Node pool.
- Set `max_tokens` on AI calls or generated code truncates → build errors.
- **Line-addressed edits**: the author (`workers-ai-author.ts`) shows the model
  the files with line numbers and asks for `@@REPLACE/INSERT/DELETE/CREATE n@@`
  ops — NOT whole-file rewrites. `parseEdits` reads them; `applyEdits` applies
  them bottom-up (so original line numbers stay valid), validates bounds/overlap,
  and throws a clear, model-actionable message on a bad op. Whole-file `===FILE:`
  output is still accepted as a fallback. Keep this format in sync with
  `EDIT_OUTPUT_FORMAT` and the numbered `renderFiles` output.
- The AI author **streams** the model response and enforces an overall +
  per-chunk idle timeout (configurable via `AUTHOR_TIMEOUT_MS`). Streaming avoids
  the hard "3046 Request timeout" a non-streamed call throws on long generations;
  a genuine stall now surfaces a clear error and leaves the live version intact.
  The reader accepts BOTH stream schemas: classic Workers AI (`{response}`) and
  OpenAI-style (`choices[].delta.content`; reasoning tokens are ignored) — needed
  because the default model uses the latter.
- **Self-heal**: `AppHost.editWithAI` runs a retry loop (`MAX_AI_REPAIRS` in
  `app-host.ts`). It feeds BOTH failure kinds back to `CodeAuthor.repair()`,
  validating WITHOUT saving so only the final result becomes a version:
  an APPLY failure (an op referenced a nonexistent line — retried against the
  ORIGINAL files) and a BUILD failure (the applied code didn't compile — the
  broken files are handed back to fix). Its ceiling is the MODEL: the default
  (`@cf/openai/gpt-oss-120b`, set in `workers-ai-author.ts`, overridable via
  `AUTHOR_MODEL`) reliably reads line numbers and emits correct positions; weaker
  models (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
  `@cf/qwen/qwen2.5-coder-32b-instruct`) DROP the literal or line number being
  changed, so their line ops never apply and repeating the error doesn't help.
  For big structural rewrites, prefer small incremental edits or hand-editing.
- AI/manual output is validated by bundling (`runner.bundleApp`) in `setFiles`
  before going live. Broken versions are saved (not discarded) so they can be
  inspected/rolled back, but they are NOT promoted — the live pointer stays on
  the last version that built and `status` flips to `error`. Auto-promotion
  still happens for any version that builds. (Manual `rollback` may still land
  on a broken version on purpose, for inspection.)
- Local DO state persists in `.wrangler/` across dev restarts.
