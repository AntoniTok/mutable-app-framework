# Mutable App Framework

A **self-modifying application framework** built on Cloudflare's Agents SDK,
Durable Objects, and Dynamic Workers.

An "app" is not deployed as code — it lives as **data** inside a Durable Object.
Requests run the app's *current* source in an isolated Dynamic Worker. You change
the app — by hand or by asking an AI — and the next request runs the new code.
**No redeploy, no restart.** Every change is versioned, so you can roll back.

> Status: learning prototype. Uses preview-grade Cloudflare APIs (Dynamic Worker
> Loader, `@cloudflare/worker-bundler`). Fine for experiments; not production.

---

## Mental model

```
                    ┌──────────────── STABLE CORE (the framework) ───────────────┐
Browser ─── HTTP ──▶│  server.ts → AppHost (Durable Object, one per room)        │
 lobby + room UI    │    • stores app source + version history in its own SQLite   │
                    │    • runs the live version in a sandbox (runner.ts)          │
                    │    • rewrites the app via an AI author (host-side)           │
                    │  contracts:  CodeAuthor        AppTemplate + fetch()          │
                    └──────▲───────────────────────────────────▲──────────────────┘
                           │ implements                         │ conforms to
                     AI author (swappable)              app templates (swappable,
                     Workers AI / OpenAI / …            include their own UI)
```

Three layers, two of them swappable:

1. **Stable core** — stores code, runs code, mutates code, sandboxes code. Never
   changes when you swap apps or models.
2. **AI author** (swappable) — turns an instruction + current files into new
   files. Behind the `CodeAuthor` interface.
3. **App templates** (swappable) — the actual apps, incl. their own UI. Behind
   the `AppTemplate` interface + the runtime contract.

### Key idea: the app is untrusted

The app's code may be AI-written, so it runs in a **Dynamic Worker** with:

- **only one capability**: a `SYSTEM` broker it must *ask* for resources, and
- **no network egress** (`globalOutbound: null`).

It cannot touch storage, secrets, or the internet directly. This is
capability-based security (Cap'n Web / Workers RPC).

---

## Quick start

```bash
npm install          # first time only
npx wrangler login   # first time only (needed for the AI binding)
npm run dev          # start local dev server
```

Open http://localhost:8787 — the **lobby**. Each room is its own isolated app
(own code, version history and live game state):

- **Create room** — generates a random id and opens that room.
- **Join room** — enter an existing id to open that room.

A room opens at `/room.html?room=<id>` on the **live app** (the game); open it
in two tabs to play multiplayer. Press **Edit** in the room to reveal the tools
(they stay hidden otherwise). No `?room=` anywhere defaults to room `main`.

The room's **Edit** tools let you:

- **Run** — execute the app at the given path (default `/`).
- **Rendered / Raw** — render the app's HTML page, or show the raw response.
- **Reset app** — re-seed from the template (clean slate; keeps history).
- **Save** (Code panel) — save the edited files as a new version.
- **Ask AI** (Ask AI panel) — describe a change; the AI rewrites the code and
  saves a version.
- **rollback** (History panel) — move the live pointer to any past version.

In Edit mode each panel is togglable from the header, so you can hide what you
don't need and give the live app more room:

- **Controls** — the Run / Rendered / Reset bar.
- **Ask AI** — the AI edit bar.
- **Code** — the file editor.
- **History** — the version list.

Press **Edit** again (**Done**) to hide the tools and go back to just the app.
The rendered preview auto-refreshes after every change (save / AI edit / reset /
rollback), so what you see always matches the live version.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Local dev server (`wrangler dev`) |
| `npm run deploy` | Deploy to Cloudflare (`wrangler deploy`) |
| `npm run types` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | Runtime checks for the live app (dev server must be running) |

---

## Project structure

```
src/
  server.ts                    Entry Worker. Routes /api/*, /preview/*, /agents/*.
  types.ts                     Env bindings + AppDataStore RPC interface.

  agent/
    app-host.ts                THE AGENT (Durable Object): stores/versions code,
                               runs it, editWithAI / setFiles / rollback / reset.
    schema.ts                  SQLite tables (files, versions, app_data) + helpers.
    runner.ts                  Bundles live code + runs it in a Dynamic Worker
                               (SYSTEM only, no egress, content-hash cached).
                               runApp() serves fetch; reduce()/initialState()
                               call the app's pure reducer via an injected
                               adapter entrypoint (both share one bundle).

  capabilities/
    broker.ts                  The gatekeeper (env.SYSTEM). requestStore() active;
                               requestBlobStore / requestRoom reserved.
    scoped-store.ts            Per-app key/value store backed by app_data.

  author/
    types.ts                   CodeAuthor interface (the swappable-AI seam).
    workers-ai-author.ts       Workers AI implementation (runs host-side).

  templates/
    types.ts                   AppTemplate interface + the RUNTIME CONTRACT
                               (incl. the optional REALTIME CONTRACT).
    registry.ts                The app catalog + the single hosted app switch.
    examples/
      poker.ts                 EXAMPLE APP (default seed): realtime multiplayer
                               with HIDDEN INFORMATION (per-player views).
      tictactoe.ts             EXAMPLE APP: realtime multiplayer (symmetric).
      counter.ts               EXAMPLE APP: simple interactive counter.

  realtime/
    coordinator.ts             The realtime engine: WS connections, presence,
                               app-defined seats, per-player broadcast; drives
                               the app's pure reducer + optional view projection.
                               Serializes transitions so concurrent frames don't
                               race.

public/
  index.html                   The lobby (create/join a room), served at /.
  room.html                    A room: live app + on-demand editor ("Edit"),
                               at /room.html?room=<id>.

wrangler.jsonc                 Bindings: AppHost DO, LOADER, AI, static assets.
worker-configuration.d.ts      Generated binding/runtime types (npm run types).
```

---

## How it works (request flows)

**Run the app**
```
Browser → server.ts (/preview/*) → AppHost.preview()
        → runner.runApp(): bundle live files → LOADER.get(hash) (isolated worker)
            env = { SYSTEM: broker },  globalOutbound = null
        → app.fetch() runs; may call env.SYSTEM.requestStore() → ScopedStore
            → back into AppHost's app_data table (per-app, per-namespace)
        → response returned; HTML gets <base href="/preview/"> injected so the
          app's relative links/buttons work inside the preview.
```

**Change the app (AI)**
```
Browser "add X" → server.ts (/api/edit) → AppHost.editWithAI()
        → WorkersAiAuthor: prompt(numbered current files + contract) → model →
          LINE-EDIT ops (@@REPLACE/INSERT/DELETE/CREATE n@@) applied to the files
          (small + fast; never a full-file rewrite) → new files
        → self-heal: bundle to validate; on an APPLY error (op referenced a bad
          line) or a BUILD error, feed it back to author.repair() and retry (up
          to MAX_AI_REPAIRS) — validated, not saved
        → AppHost.setFiles(): saves the final version, then bundles it.
          Only if it builds does the live pointer move (auto-promote); a broken
          build is saved but NOT promoted — the last good version stays live.
        → next run uses the new code (or the old code, if the new one failed).
```

**Change the app (manual)** — the editor calls `/api/files`; same as above minus
the model.

**Rollback** — `/api/rollback` moves the live pointer to an older version.

---

## Storage model (two tiers)

Everything lives in the AppHost's own SQLite (per instance, per app):

- `files(version, path, content)` — the source code, one row per file per version.
- `versions(id, ts, note)` — the history list (enables rollback).
- `app_data(scope, k, v)` — the running app's own key/value data (reached via the
  broker), separate from its code.

Small, synced state (`this.setState`) holds only a pointer:
`{ activeVersion, status, templateId, lastError }`. Code is kept in SQL (never
in synced state) so it isn't rebroadcast on every change.

> Note: the room page reads this pointer by **polling** `GET /api/state`
> after each action (not via a live state subscription), so a brief transient
> `status: "building"` may not be visible in the UI.

---

## The runtime contract (what every app must do)

Defined in `src/templates/types.ts`. An app's files must:

- Provide a default export with `async fetch(request, env)`.
- Serve a real HTML page at `/` (content-type `text/html`) with the UI, and put
  actions behind data endpoints that return JSON.
- Persist ONLY via `env.SYSTEM`:
  ```js
  const store = await env.SYSTEM.requestStore("my-namespace");
  await store.put(key, value);        // value is a string
  const v = await store.get(key);     // string | null
  await store.list();                 // string[]
  await store.delete(key);
  ```
- Make **no** external network calls (egress is blocked).
- Use **relative** URLs in HTML (`fetch("inc")`, not `/inc`) — the app is
  previewed under `/preview/`.

`AppTemplate.declares` lists the capabilities an app expects (e.g. `"store"`,
`"room"`). Multiplayer apps additionally export a pure `applyAction` reducer (+
optional `initialState`) — see [Multiplayer](#multiplayer-live-pure-reducer).

---

## Extending it

### Add a new example / app template

1. Create `src/templates/examples/<name>.ts` exporting an `AppTemplate` that
   follows the runtime contract.
2. Register it in `src/templates/registry.ts`.
3. Make it the hosted app. **This framework runs one app at a time**: set the
   single `DEFAULT_TEMPLATE_ID` constant in `src/templates/registry.ts` to your
   app's id (`AppHost.initialState.templateId` derives from it). Every room then
   seeds from it. (A room already in `.wrangler/` keeps its seeded code — use a
   fresh room id, or clear `.wrangler/`, after switching.)

All three bundled example apps (`poker`, `tictactoe`, `counter`) conform to the
current contract and can be hosted this way; `npm run smoke` checks whichever one
is live (set `DEFAULT_TEMPLATE_ID`, restart `npm run dev`, re-run to cover all).

### Swap the AI model

Implement `CodeAuthor` (see `src/author/types.ts`) in a new file (e.g. an OpenAI
version) and use it in `AppHost.#getAuthor()`. Nothing else changes. The default
model is configurable via the `AUTHOR_MODEL` var; default is
`@cf/openai/gpt-oss-120b` — line-addressed editing needs a model that reliably
reads line numbers off the numbered file and emits exact positions, which it does
(small correct edits in ~2-4s). Weaker instruct/coder models (e.g.
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/qwen/qwen2.5-coder-32b-instruct`)
drop the literal or line number being changed and their edits fail to apply;
cheaper alternatives that still work are `@cf/openai/gpt-oss-20b` and
`@cf/qwen/qwen3-30b-a3b-fp8`. The stream reader handles both the classic Workers
AI (`{response}`) and OpenAI-style (`choices[].delta.content`) response schemas.
Override per-instance with a `.dev.vars` line `AUTHOR_MODEL="..."` locally, or
`wrangler.jsonc` `vars` for deploys.

### Add a new resource (e.g. R2 for images)

The **broker is the growth point**. Adding a resource type is additive:

1. Bind the resource to the host in `wrangler.jsonc`.
2. Add one `request*` method to `CapabilityBroker` (see reserved
   `requestBlobStore` / `requestRoom` hooks) that returns a scoped capability
   stub, prefixed by `props.instance` for isolation.

The app contract and runner don't change — apps just call
`env.SYSTEM.requestBlobStore(...)`.

### Multiplayer (live: pure-reducer)

`src/realtime/coordinator.ts` is the realtime engine. It owns everything an
untrusted app must NOT be handed directly — WebSocket connections, presence,
seat assignment, persistence and broadcast — and drives the app's **pure**
reducer in the sandbox:

```
client --ws--> AppHost.onMessage --> coordinator.onMessage
   --> runner.reduce(files, state, action, ctx)   [sandboxed, pure]
   --> persist new state --> broadcast {type:"state"} to all clients
```

An app opts into multiplayer with pure named exports (see the REALTIME CONTRACT
in `src/templates/types.ts`):

```js
export const seats = ["X", "O"];                  // seat pool (app-defined)
export const initialState = { ... };              // starting shared state
export function applyAction(state, action, ctx) { // pure reducer
  // ctx = { seat, playerId }; return state unchanged to reject an action.
  // Math.random() is allowed here (its result is persisted as the next state).
  return nextState;
}
```

The client page connects a WebSocket to `/agents/app-host/<room>?token=…` (the
room read from the page's own `location`, default `main`), sends
`{type:"action", action}` frames, and renders each `{type:"state"}`
broadcast (after an initial `{type:"welcome", seat}`). The example
`tictactoe` app shows the whole pattern end-to-end; `poker` (the default seed)
adds hidden information on top (see below).

Seats are opaque player slots the coordinator assigns bound to a stable browser
token: a brief disconnect keeps your seat, and a departed player's seat is only
reclaimed when another player needs it. **Seat names are declared by the app**
via the optional `seats` export (the framework core names none); no `seats`
export means everyone is a spectator (`ctx.seat === null`).

### Multiplayer (asymmetric views: hidden information)

By default every client receives the **same** state broadcast. Some games need
each player to see something **different** — your poker hand is yours alone. An
app opts in with one more pure export, `view(state, ctx)`:

```js
export function view(state, ctx) {   // ctx = { seat, playerId }
  // Return only the slice THIS viewer may see. The reducer keeps one full
  // authoritative state (deck, everyone's cards); `view` is the single place
  // that decides visibility — hide the rest here.
  return projectedStateForThisSeat;
}
```

The coordinator projects the state **per connection** (batched into one
sandboxed call via `runner.project()`) and sends each client its own
`{type:"state"}` frame — so secret data never leaves the server. Absent a `view`
export, the full state is broadcast to everyone (symmetric apps like tic-tac-toe
are unchanged). The `poker` example (the default seed) demonstrates the whole
pattern: each player sees only their own hole cards until showdown.

> Concurrency: the coordinator **serializes** state transitions (a promise
> chain), so two players acting at the same instant can't race and clobber each
> other's writes (a real hazard, since the DO input gate releases during the
> sandbox RPC `await`).

> **Follow-up (poker):** the `poker` example uses a single main pot. Proper
> **side pots / short all-in** handling (when a player is all-in for less than a
> later bet) is intentionally out of scope for now, and is the natural next step
> for that example. It's an app-level change (`applyAction`/`view` in
> `src/templates/examples/poker.ts`) — no framework core change needed.

**Still reserved:** the *app-driven* realtime path (`broker.requestRoom()`),
where an app gets a `Room` capability and drives broadcast itself. It can be
added later as a second consumer of this same engine, without changing the
pure-reducer apps.

Realtime state lives in the AppHost's `app_data` table under a reserved
`__room__` scope (not in the synced pointer state), and is reset to
`initialState` automatically when the app's live version changes.

---

## HTTP API (host worker)

| Method + path | Body | Returns |
| --- | --- | --- |
| `GET /api/state` | — | `{ activeVersion, status, templateId, lastError }` |
| `GET /api/files` | — | `{ files: [{ path, content }] }` |
| `GET /api/versions` | — | `{ versions: [{ id, ts, note }] }` |
| `POST /api/files` | `{ files, note? }` | `{ version }` |
| `POST /api/edit` | `{ instruction }` | `{ version }` |
| `POST /api/reset` | — | `{ version }` |
| `POST /api/rollback` | `{ version }` | `{ ok: true }` |
| `ANY /preview/<path>` | — | the app's response (HTML gets `<base>` injected) |
| `WS /agents/app-host/<room>` | — | realtime channel for multiplayer apps (see Multiplayer) |

All `/api/*` and `/preview/*` routes take an optional `?room=<id>` selecting the
target room (its own Durable Object); the id is the DO name on the `/agents/*`
WS route. Missing/invalid `?room=` resolves to `main`.

Each room name = a different, isolated app (its own Durable Object, code,
version history and realtime state). The default room is `main`.

---

## Gotchas / notes

- **Preview-grade APIs.** Dynamic Worker Loader + `worker-bundler` are new; pin
  versions and confirm the `worker_loaders` binding is enabled on your account.
- **AI output is validated by building it** (`runner.bundleApp`) before it goes
  live. A broken version is still saved (so you can inspect/fix or roll back to
  it), but it is NOT promoted — the live pointer stays on the last version that
  built, and `status` flips to `error` with the build message in `lastError`.
- **`max_tokens`** is set high in the author (small defaults truncate code and
  cause "Unterminated string literal" build errors).
- **Line-addressed edits.** The author shows the model the current files with
  line numbers and asks for `@@REPLACE/INSERT/DELETE/CREATE n@@` ops (parsed by
  `parseEdits`, applied bottom-up by `applyEdits` so original line numbers stay
  valid). It never rewrites whole files, so edits are small and fast (~2-4s vs
  the old multi-minute full-file regen) and a slip can't corrupt untouched code.
  If the model returns whole `===FILE:` blocks instead, the author falls back to
  those. NOTE: this needs a model that can emit exact positions — see the model
  gotcha below.
- **The AI author streams** its response and applies overall + idle timeouts
  (tune with the `AUTHOR_TIMEOUT_MS` var). Streaming avoids Workers AI's hard
  "3046 Request timeout" on long generations; a real stall fails with a clear
  message and the live version is untouched. The reader accepts both the classic
  Workers AI (`{response}`) and OpenAI-style (`choices[].delta.content`, reasoning
  tokens ignored) stream schemas.
- **Self-heal:** when an edit fails to APPLY (an op cited a bad line) or fails to
  BUILD, the host feeds the exact error back to the model (`CodeAuthor.repair()`)
  and retries up to `MAX_AI_REPAIRS` times, validating before saving so only the
  final result becomes a version. Its ceiling is the MODEL: the default
  `@cf/openai/gpt-oss-120b` reads the numbered file and emits correct line ops;
  weaker models (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
  `@cf/qwen/qwen2.5-coder-32b-instruct`) drop the very literal or line number
  being changed — so their edits never apply, and repeating the error doesn't
  help. Big structural rewrites are still best done as small incremental edits.
- **Rendered vs Raw.** The preview renders HTML in a sandboxed iframe; relative
  URLs work via an injected `<base href="/preview/">`. Absolute app URLs (`/x`)
  will not reach the app — the AI is steered toward relative URLs.
- **Local state persists** across `wrangler dev` restarts (Durable Object
  storage in `.wrangler/`), so your versions survive restarts.
```
