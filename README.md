# Mutable App Framework

A **self-modifying application framework** built on Cloudflare's Agents SDK,
Durable Objects, and Dynamic Workers.

An "app" is not deployed as code, it lives as **data** inside a Durable Object.
Requests run the app's *current* source in an isolated Dynamic Worker. You change
the app, by hand or by asking an AI, and the next request runs the new code.
**No redeploy, no restart.** Every change is versioned, so you can roll back.

> Status: learning prototype. Uses preview-grade Cloudflare APIs (Dynamic Worker
> Loader, `@cloudflare/worker-bundler`). Fine for experiments; not production:
> see [Hardening status](#hardening-status) for what's been addressed and what
> still blocks real use (notably auth and quotas).

---

## Mental model

**The shape of the system:** there is **one Worker** at the front. Every *room*
behind it is a set of **Durable Objects**, **not** its own Worker. The single
Worker routes each request to a room's DOs by id, and each app's code runs in an
ephemeral **Dynamic Worker**:

```
                 ┌──────────┐   ┌──────────┐   ┌──────────┐
   Browsers      │  lobby   │   │  room A  │   │  room B  │   (tabs)
                 └────┬─────┘   └────┬─────┘   └────┬─────┘
                      └──────── HTTP / WebSocket ───┘
                                     │
                        ╔════════════▼══════════════╗
                        ║   ONE Worker  server.ts   ║  the only *deployed* Worker:
                        ║   serves lobby + rooms,   ║  a stateless front door that
                        ║   routes by ?room=<id>    ║  routes to each room's DOs
                        ╚═══════╤═══════════╤═══════╝
                 getAgentByName(A)         getAgentByName(B)
                 ┌──────────────▼───┐   ┌───▼──────────────┐
                 │ ROOM A = DOs     │   │ ROOM B = DOs     │  a "room" is a set of
                 │  AppHost (Agent) │   │  AppHost (Agent) │  Durable Objects,
                 │  CodeAssistant   │   │  CodeAssistant   │  NOT its own Worker
                 │  AppData/Sql/... │   │  AppData/Sql/... │
                 │        │         │   │        │         │
                 │  env.LOADER.get  │   │  env.LOADER.get  │
                 │        ▼         │   │        ▼         │
                 │  Dynamic Worker  │   │  Dynamic Worker  │  runs the app's code
                 │  (runs A's app)  │   │  (runs B's app)  │  (ephemeral, untrusted)
                 └──────────────────┘   └──────────────────┘
                    isolated from B         isolated from A
```

- **One Worker** (`server.ts`): the only *deployed* Worker. Stateless front
  door: serves the lobby and every room page, and routes each request to the
  right room's DOs by `?room=`. (It scales to many edge instances, but it's one
  codebase/deployment, there is no per-room Worker.)
- **A "room" = Durable Objects**: each room is a small cluster of DOs
  (`AppHost`, `CodeAssistant`, `AppData`, `AppSql`, `AppScheduler`) holding that
  room's code, data and realtime state. Two rooms are fully isolated.
- **Agent / Think**: not separate infrastructure, just DO base classes:
  `AppHost extends Agent`, `CodeAssistant extends Think` (both are Durable
  Objects with extra conveniences like state sync, WS routing, scheduling).
- **Dynamic Worker**: an ephemeral isolate the Worker Loader creates *at
  runtime* to execute an app's code-as-data (`env = { SYSTEM }` only). Not
  deployed; created per room's current code version.

The same system split by **responsibility** is three layers, two swappable:

```
                    ┌──────────────── STABLE CORE (the framework) ───────────────┐
Browser ─── HTTP ──▶│  server.ts → AppHost (Durable Object, one per room)        │
 lobby + room UI    │    • stores app CODE + version history in its own SQLite   │
                    │    • runs the live version in a sandbox (runner.ts)        │
                    │    • app runtime data lives in a separate AppData DO       │
                    │    • edits the app via an AI assistant (host-side)         │
                    │  contracts:  AppHost RPC        AppTemplate + fetch()      │
                    └──────▲───────────────────────────────────▲─────────────────┘
                           │ tool-calls (RPC)                  │ conforms to
                     AI assistant (Think DO)            app templates (swappable,
                     agentic + memory                   include their own UI)
```

1. **Stable core**: stores code, runs code, mutates code, sandboxes code. Never
   changes when you swap apps or models.
2. **AI assistant**: a separate per-room Durable Object (`CodeAssistant extends
   Think`) that edits the app through a multi-turn, agentic, memory-aware chat.
   It only ever touches app code through the core's `AppHost` RPC (build-gated),
   so it stays trusted host-side code on the safe side of the sandbox.
3. **App templates** (swappable): the actual apps, incl. their own UI. Behind
   the `AppTemplate` interface + the runtime contract.

> **See it visually.** Two architecture pages ship with the framework: rendered
> on GitHub Pages:
> [**Diagrams**](https://antonitok.github.io/mutable-app-framework/architecture-diagrams.html)
> (the overall **framework structure** and a single **deployed room + lobby**, with
> every part marked *always present* vs *optional*) and
> [**Prose reference**](https://antonitok.github.io/mutable-app-framework/architecture.html)
> (a walkthrough of every path: request, edit, realtime, capabilities, security).
> Source lives in `public/` ([`architecture.html`](public/architecture.html),
> [`architecture-diagrams.html`](public/architecture-diagrams.html)) and is also
> served by the dev server at `/architecture` and `/architecture-diagrams`.

### Key idea: the app is untrusted

The app's code may be AI-written, so it runs in a **Dynamic Worker** with:

- **only one capability**: a `SYSTEM` broker it must *ask* for resources, and
- **no direct network egress** (`globalOutbound: null`).

It cannot touch storage, secrets, or the internet directly, the only way out is
a broker-**mediated** fetch (`requestFetch`), restricted to a per-app host
allowlist. This is capability-based security (Cap'n Web / Workers RPC).

---

## Quick start

```bash
npm install          # first time only
npx wrangler login   # first time only (needed for the AI binding)
npm run dev          # start local dev server
```

Open http://localhost:8787, the **lobby**. Each room is its own isolated app
(own code, version history and live game state):

- **Create room**: generates a random id and opens that room.
- **Join room**: enter an existing id to open that room.

A room opens at `/room.html?room=<id>` on the **live app** (the game); open it
in two tabs to play multiplayer, each tab is its own player (see
[player identity](#player-identity-reconnection)). Press **Edit** in the room to
reveal the tools (they stay hidden otherwise). No `?room=` anywhere defaults to
room `main`.

The room's **Edit** tools let you:

- **Run**: execute the app at the given path (default `/`).
- **Rendered / Raw**: render the app's HTML page, or show the raw response.
- **Reset app**: re-seed from the template (clean slate; keeps history).
- **Save** (Code panel): save the edited files as a new version.
- **Chat** (Chat panel): talk to the AI coding assistant; it edits the app for
  you across a multi-turn conversation (see below), saving versions as it goes.
- **rollback** (History panel): move the live pointer to any past version.
- **Resources** (Resources panel): inspect the capability catalog and configure
  this app's resources: resource limits (`#5`), the egress allowlist, secrets
  (add/remove; values are write-only), and the email policy + daily-send usage.

In Edit mode each panel is togglable from the header, so you can hide what you
don't need and give the live app more room:

- **Controls**: the Run / Rendered / Reset bar.
- **Chat**: the AI coding assistant (conversational, agentic).
- **Code**: the file editor.
- **Resources**: the capabilities + per-app config editor (limits/egress/secrets/email).
- **History**: the version list.

Press **Edit** again (**Done**) to hide the tools and go back to just the app.
The rendered preview auto-refreshes after every change (save / AI chat turn /
reset / rollback), so what you see always matches the live version. And when a
change promotes a new live version, **every connected client auto-reloads** too
(not just the tab that made the edit), see [live reload](#live-reload).

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
  types.ts                     Env bindings (incl. BLOBS/R2) + AppDataStore
                               (store incl. atomic incr/cas) / AppFsStore /
                               AppEgressPolicy RPC interfaces.

  agent/
    app-host.ts                THE AGENT (Durable Object): stores/versions CODE,
                               runs it, setFiles / rollback / reset / preview.
                               Holds only CODE (+ trusted __room__/__egress__/
                               __limits__/__secrets__/__email__ scopes), NOT app
                               runtime data (that's the AppData DO).
    app-data.ts                AppData Durable Object: the app's runtime data
                               (key/value store + dofs filesystem) in its OWN
                               isolated SQLite, one per room. Reached DIRECTLY by
                               the ScopedStore/ScopedFilesystem stubs (2 hops, not
                               via AppHost). dofs bundled + tree-shaken normally.
    app-scheduler.ts           AppScheduler Durable Object: the app's task scheduler
                               (broker.requestScheduler) in its OWN SQLite + a DO
                               alarm. Runs the app's onSchedule(env, ctx) export
                               when a task comes due (via runner.runSchedule):
                               one-shot/absolute/recurring. Reached directly by the
                                ScopedScheduler stub; loads code from AppHost by RPC.
    app-sql.ts                 AppSql Durable Object: the app's private RELATIONAL
                               database (broker.requestSql) in its OWN SQLite, one
                               per room. A real SQL surface (arbitrary tables +
                               queries) distinct from AppData's flat KV. Reached
                               directly by the ScopedSql stub; enforces the trusted
                               row/DB-size caps locally (pushed from setLimits).
    schema.ts                  AppHost SQLite tables (files, versions, builds
                               [precompiled bundles]; app_data holds ONLY the
                               framework __room__ + __egress__ + __upgrade__ +
                               __limits__ + __secrets__ + __email__ scopes) + helpers.
    runner.ts                  Bundles live code + runs it in a Dynamic Worker
                               (SYSTEM only, no egress, content-hash cached,
                               DynamicWorkerTail attached; uses persisted builds on
                               a cold cache). runApp() serves fetch;
                               reduce()/initialState()/probe()/migrate() call the
                               app's pure exports, runUpgrade() the app's onUpgrade
                               data migration (#10), runSchedule() the app's onSchedule
                               task handler (#2.4), via an injected adapter (one bundle).

  observability/
    dynamic-worker-tail.ts     DynamicWorkerTail: captures each untrusted app
                               run's logs/exceptions/outcome into Workers Logs,
                               tagged by workerId.

  capabilities/
    manifest.ts                The capability catalog: the SINGLE source of truth
                               for what env.SYSTEM offers. The `declares` vocab
                               (CapabilityId), the assistant system-prompt contract
                               (renderCapabilityContract) and the human docs all
                               derive from it, add a capability here once, not in
                               three places. Marks each available/reserved.

  config/
    limits.ts                  Per-app resource limits (#5): the SINGLE source of
                               GENEROUS defaults + clamps + merge. Read by the
                                runner (cpuMs/subRequests), ScopedFetcher (timeout/
                               max-bytes/redirects), AppData (store byte caps),
                               ScopedEmail (emailPerDay), ScopedScheduler
                               (maxScheduledTasks) and AppSql (sqlMaxRows/
                               sqlMaxDbBytes). Overridable via GET/POST /api/limits.

  capabilities/
    broker.ts                  The gatekeeper (env.SYSTEM). requestStore() +
                               requestSql() + requestFilesystem() +
                               requestBlobStore() + requestFetch() +
                               requestSecrets() + requestEmail() + requestRoom() +
                               requestScheduler() active. No reserved hooks remain.
    scoped-store.ts            Per-app key/value store (mediated here; backed by
                               the AppData DO, reached directly). Includes ATOMIC
                               incr()/cas() and JSON putJSON()/getJSON() helpers.
    scoped-sql.ts              Per-app RELATIONAL database (exec/query/first/run
                               with ?-bound params; backed by the AppSql DO, reached
                               directly). A real SQL surface for tabular/related/
                               aggregated data; row + DB-size caps enforced in AppSql.
    scoped-filesystem.ts       Per-app filesystem (namespace-scoped, path-sanitised;
                               dofs runs in the AppData DO, reached directly).
    scoped-blob-store.ts       Per-app R2-backed BLOB store for large binaries
                               (key-prefixed per instance/namespace).
    scoped-fetcher.ts          Mediated outbound fetch (send()): app stays egress-
                               null; only allowlisted hosts are reachable (per-hop
                               redirect re-check + timeout/size caps). Injects
                               secretHeaders host-side (use-not-read).
    scoped-secrets.ts          Read-only secrets view (has/list/get). get() works
                               ONLY for secrets flagged readable; otherwise use
                               secretHeaders on requestFetch. Values live in
                               trusted AppHost storage (__secrets__ scope).
    scoped-email.ts            Mediated transactional email (send()): validates the
                               sender/recipients against the room's policy + reserves
                               a slot in the daily cap (AppHost, serialized), then
                               calls the host-side EMAIL binding. App can't spoof
                               From or exceed emailPerDay. Policy: __email__ scope.
    scoped-room.ts             App-driven realtime (broadcast/send/presence): a
                               mediated handle to the room's live WS clients, reached
                               by RPC into AppHost (the DO that owns the sockets).
                               The app pushes {type:"app",data} frames from its own
                               code; the pure reducer stays the default path.
    scoped-scheduler.ts        Task scheduler (after/at/every/cancel/list): schedules
                               work in the AppScheduler DO; the app's onSchedule
                               export runs when due. Pending tasks capped by
                               maxScheduledTasks; delays/intervals floored to 1s.

  assistant/
    code-assistant.ts          THE AI CODING ASSISTANT: a separate Durable Object
                               (CodeAssistant extends Think, @cloudflare/think).
                               One per room; runs the agentic tool-calling loop
                               with per-room memory. Its host-side tools edit the
                               room's app ONLY via AppHost (build-gated setFiles).

  author/
    types.ts                   CodeAuthor interface (legacy one-shot seam).
    workers-ai-author.ts       Line-edit engine (parseEdits/applyEdits) reused by
                               the assistant's apply_line_edits tool. The old
                               one-shot WorkersAiAuthor is kept but unwired.

  templates/
    types.ts                   AppTemplate interface + the RUNTIME CONTRACT
                               (incl. the optional REALTIME CONTRACT).
    registry.ts                The app catalog + the single hosted app switch.
    examples/
      blackjack.ts             EXAMPLE APP (default seed): realtime multiplayer
                               Blackjack 21 vs. a shared dealer, with HIDDEN
                               INFORMATION (the dealer's hole card).
      poker.ts                 EXAMPLE APP: realtime multiplayer with HIDDEN
                               INFORMATION (per-player views).
      tictactoe.ts             EXAMPLE APP: realtime multiplayer (symmetric).
      counter.ts               EXAMPLE APP: simple interactive counter (store).
      notes.ts                 EXAMPLE APP: notes pad backed by the filesystem
                               capability (folders / read / write / list).

  realtime/
    coordinator.ts             The realtime engine: WS connections, presence,
                               app-defined seats, per-player broadcast; drives
                               the app's pure reducer + optional view projection.
                               Serializes transitions so concurrent frames don't
                               race. Also exposes presence() for the app-driven
                               Room capability (broker.requestRoom → ScopedRoom).

public/
  index.html                   The lobby (create/join a room), served at /.
  room.html                    A room: live app + on-demand editor ("Edit") with
                               Chat/Code/Resources/History panels, at
                               /room.html?room=<id>. The Resources panel reads one
                               GET /api/resources snapshot and writes through the
                               /api/{limits,egress,secrets,email} routes.
  architecture.html            Prose architecture reference (overview, what runs
                               the code, code-as-data, request/edit/realtime paths,
                               the DOs, capabilities, security). Served at
                               /architecture.
  architecture-diagrams.html   Two diagrams, the framework structure and a single
                               deployed room/lobby, each box marked always vs
                               optional. Served at /architecture-diagrams.

wrangler.jsonc                 Bindings: AppHost + CodeAssistant + AppData +
                               AppScheduler + AppSql DOs, LOADER, AI, BLOBS (R2),
                               EMAIL (send_email), static assets, ASSISTANT_MODEL var,
                               observability (head_sampling_rate: 1 for the tail).
worker-configuration.d.ts      Generated binding/runtime types. NOTE: `npm run
                               types` regenerates a stricter d.ts that breaks tsc;
                               the committed copy is hand-kept (add bindings by hand).

scripts/
  smoke.mjs                    Dependency-free runtime smoke test for the live app.

vendor/
  dofs/                        Vendored @cloudflare/dofs (unpublished): its built
                               dist is committed and referenced via a file:
                               dependency. Bundled (tree-shaken) into the AppData
                               DO to power the filesystem capability.
```

---

## How it works (request flows)

**Run the app**
```
Browser → server.ts (/preview/*) → AppHost.getRunManifest()  (fetch CODE only)
        → runner.runApp() IN THE HOST WORKER (not the DO, so the response can
          STREAM): LOADER.get(hash) → isolated worker. On a COLD cache the
          precompiled build (persisted on promote) is used; else it bundles.
            env = { SYSTEM: broker },  globalOutbound = null,  tails = [tail]
        → app.fetch() runs; may call env.SYSTEM.requestStore() → ScopedStore
            → the AppData DO directly (its own isolated SQLite; 2 hops, not AppHost)
        → response STREAMED back; HTML gets <base href="/preview/"> injected via
          HTMLRewriter (also streaming) so relative links/buttons work.
        → after the run, DynamicWorkerTail ships the app's logs to Workers Logs.
```
(The assistant's `preview` tool still uses `AppHost.preview()`, which buffers +
truncates, only the user-facing `/preview/*` path streams.)

**Change the app (AI, the assistant)**
```
Browser Chat panel --ws--> /agents/code-assistant/<room> --> CodeAssistant (Think)
        → agentic loop: model calls host-side TOOLS → reads results → loops
            read_file / list_files / preview / list_versions / get_state   (read)
            apply_line_edits (FAST path) / save_version / rollback / reset_app
            code_mode: ONE script orchestrating the read/edit tools in an
                       isolated Dynamic Worker (fewer round-trips; see below)
        → every edit tool calls AppHost.setFiles(): saves the version, bundles it.
          Only if it builds does the live pointer move (auto-promote); a broken
          build is saved but NOT promoted, the last good version stays live.
        → the tool returns the build outcome; if it failed, the model reads the
          error and makes a follow-up edit (self-heal IS the loop).
        → per-room MEMORY (a writable Session context block) persists facts about
          the app across turns; conversation history is stored + FTS5-searchable.
        → on a successful promote, AppHost broadcasts {type:"reload"} (debounced)
          so EVERY connected client reloads onto the new version (see Live reload).
        → next run uses the new code (or the old code, if the new one failed).
```

**Change the app (manual)**: the editor calls `/api/files`; saves + build-gates
a new version, no model involved.

**Rollback**: `/api/rollback` moves the live pointer to an older version.

---

## Storage model (code vs. runtime data)

Code and app runtime data have opposite lifecycles, a versioned artifact vs.
live mutable state, so they live in **separate** SQLite databases.

**AppHost's own SQLite** holds the CODE (the source of truth):

- `files(version, path, content)`: the source code, one row per file per version.
- `versions(id, ts, note)`: the history list (enables rollback).
- `builds(hash, main, modules, ts)`: the precompiled bundler output per content
  hash, persisted on promote so the run path skips esbuild on a cold cache
  (pruned alongside version history).
- `app_data(scope, k, v)`: the realtime engine's `__room__` state (the
  coordinator's own state) AND the reserved `__egress__` allowlist. Not app data.

**The `AppData` DO's isolated SQLite** (a separate top-level DO, one per room)
holds the app's RUNTIME DATA, reached via the broker's scoped stubs DIRECTLY (2
hops, never through AppHost, limitation #3):

- `app_data(scope, k, v)`: the app's key/value store (broker `requestStore`),
  including the atomic `incr`/`cas` primitives.
- `vfs_*`: the app's private **filesystem** (broker `requestFilesystem`), managed
  by `@cloudflare/dofs` (bundled into the `AppData` DO). A real POSIX-ish
  filesystem (folders, `stat`, `grep`, `find`) for small structured data (files
  capped at 256 KiB), not large blobs.

Relational data lives in the **`AppSql` DO's own isolated SQLite** (broker
`requestSql`), a SEPARATE top-level DO (one per room) reached directly by the
`ScopedSql` stub, a real SQL surface (the app's own tables + arbitrary queries),
distinct from AppData's flat key/value store. Row-count and DB-size caps are
enforced inside AppSql against the app's trusted limits.

Large binaries live in **R2** (broker `requestBlobStore`), keyed by an
`<instance>/<namespace>/` prefix, not in any SQLite.

The `AppData` DO has its own database (AppHost can't read it) and its own input
gate, so a chatty app can't bloat version history or contend with the realtime
coordinator, and because the scoped stubs address it directly, storage traffic
never funnels through AppHost. The untrusted app still never touches it directly:
the broker's scoped stubs validate/quota/sanitise every call. (This data was
formerly held in a Durable Object *facet* beneath AppHost; it was promoted to a
top-level DO to drop the forced third hop, see `docs/cloudflare-sdk-usage.md`.)

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
- Persist ONLY via `env.SYSTEM`. Pick the capability that fits the data; don't
  mirror the same data into two.

  A flat **key/value store** (`requestStore`), best for counters and flat values:
  ```js
  const store = await env.SYSTEM.requestStore("my-namespace");
  await store.put(key, value);        // value is a string
  const v = await store.get(key);     // string | null
  await store.list();                 // string[]
  await store.delete(key);
  // ATOMIC (safe under concurrent requests, a get()+put() pair is NOT):
  const n = await store.incr("count", 1);         // -> new number
  const ok = await store.cas("count", "1", "2");  // true if swapped
  // JSON convenience (same store, serialized for you):
  await store.putJSON("cfg", { a: 1 }); const c = await store.getJSON("cfg");
  ```

  A private **SQL database** (`requestSql`), reach for this over the flat store
  whenever data is tabular, related, filtered, sorted, or aggregated
  (leaderboards, todo lists, chat logs). Its OWN SQLite, one per room:
  ```js
  const db = await env.SYSTEM.requestSql();
  await db.exec(
    "CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, text TEXT, done INTEGER DEFAULT 0)"
  );
  await db.run("INSERT INTO todos (text) VALUES (?)", text);  // { rowsWritten, lastRowId }
  const open = await db.query("SELECT * FROM todos WHERE done = ?", 0);  // rows[]
  const one  = await db.first("SELECT * FROM todos WHERE id = ?", id);   // row | null
  // exec() returns the full { rows, columnNames, rowsRead, rowsWritten, lastRowId }.
  // ALWAYS use ? placeholders + params (never concatenate). Booleans store as 0/1.
  // Queries are row-capped (sqlMaxRows → paginate with LIMIT); the DB has a size
  // cap (sqlMaxDbBytes). Both are per-app configurable limits.
  ```

  A private **filesystem** (`requestFilesystem`), best for structured data with
  folders/paths/search. For SMALL data only (files capped at 256 KiB), not blobs:
  ```js
  const fs = await env.SYSTEM.requestFilesystem("my-namespace");
  await fs.writeFile("notes/todo.md", "text");  // parents auto-created
  const text = await fs.readFile("notes/todo.md");  // string | null (null if missing)
  const list = await fs.readdir("notes");       // [{ name, type }] | null
  const meta = await fs.stat("notes/todo.md");  // { type, size, mtime } | null
  await fs.mkdir("drafts");
  await fs.rm("notes/todo.md", { recursive: false });
  const hits = await fs.grep("milk", "notes");  // [{ path, line, text }]
  const found = await fs.find("", "*.md");      // [{ path, type }]
  ```
  Paths are namespace-relative (no leading `/`, no `..`); missing files read as
  `null`. Path sanitisation lives in the trusted `ScopedFilesystem`, not the app.

  A **blob store** (`requestBlobStore`), R2-backed, for LARGE binaries (images,
  audio, exports) that exceed the 256 KiB filesystem cap:
  ```js
  const blobs = await env.SYSTEM.requestBlobStore("uploads");
  await blobs.put("pic.png", bytes);   // ArrayBuffer | string
  const buf = await blobs.get("pic.png");   // ArrayBuffer | null
  await blobs.delete("pic.png");  await blobs.list();  // string[]
  ```
- No **direct** network egress. The app sandbox stays `globalOutbound: null`; the
  only way out is a **mediated fetch**, and only to hosts on the app's per-app
  allowlist (managed via `POST /api/egress`, never by the app itself):
  ```js
  const net = await env.SYSTEM.requestFetch();
  const res = await net.send("https://api.example.com/x", { method: "GET" });
  // res = { status, statusText, headers: [k,v][], body: ArrayBuffer }
  ```

  **Secrets** (`requestSecrets` + `requestFetch`'s `secretHeaders`), API keys /
  credentials the USER configures (`POST /api/secrets`), stored in trusted host
  storage. USE-NOT-READ: the app can use a secret without reading it. Inject one
  into an outbound request header (works even for non-readable secrets, the value
  never enters the sandbox); reading the raw value works ONLY if the user flagged
  it `readable`:
  ```js
  const net = await env.SYSTEM.requestFetch();
  await net.send("https://api.example.com/x", {
    secretHeaders: { Authorization: { secret: "MY_KEY", prefix: "Bearer " } }
  });
  const sec = await env.SYSTEM.requestSecrets();
  await sec.has("MY_KEY");  await sec.list();   // names only
  await sec.get("MY_KEY");  // raw value, only if flagged readable, else throws
  ```

  **Email** (`requestEmail`), send **transactional** email, mediated by the
  room's policy. The app can never pick an arbitrary `From` (anti-spoofing) or
  exceed its daily cap: allowed senders/recipients are configured by the USER
  (`POST /api/email`) and the per-day cap is a resource limit (`emailPerDay`, via
  `POST /api/limits`). Omit `from` to use the app's default sender; a disallowed
  sender/recipient or an exhausted cap throws with an actionable message. The
  `EMAIL` binding stays host-side, the app only sees `send()`:
  ```js
  const mail = await env.SYSTEM.requestEmail();
  await mail.send({
    to: "user@example.com",          // string | string[]; cc/bcc also allowed
    subject: "Welcome",
    text: "Thanks for signing up.",  // always include text alongside html
    html: "<p>Thanks for signing up.</p>",
    from: "noreply@example.com"      // optional; must be an allowed sender
  });
  // -> { ok: true, from: "noreply@example.com", recipients: 1 }
  ```

  **App-driven realtime** (`requestRoom`), PUSH to connected clients from your
  OWN code (an HTTP handler, a webhook, later a scheduled task), instead of only
  reacting to a WebSocket action. This is the escape hatch; the default multiplayer
  path is still the pure `applyAction` reducer (below). Messages arrive as
  `{ type: "app", data }` frames; keep your own state in `requestStore`:
  ```js
  const room = await env.SYSTEM.requestRoom();
  await room.broadcast({ kind: "toast", text: "New round!" }); // → all clients
  await room.send("A", { hand: [...] });   // → only the client in seat "A"
  const p = await room.presence();          // { seats, players, count }
  ```

  **Scheduler** (`requestScheduler`), run code LATER (reminders, timeouts,
  polling, timed realtime updates). Schedule a task, then handle it in an
  `onSchedule(env, ctx)` export that runs in the normal sandbox (full
  `env.SYSTEM`, so it can persist / fetch / email / broadcast). Pending tasks are
  capped by the `maxScheduledTasks` limit; delays/intervals are floored to 1s:
  ```js
  const s = await env.SYSTEM.requestScheduler();
  const { id } = await s.after(60, "remind", { userId });  // once, in 60s
  await s.every(300, "poll");           // recurring, every 5 min
  await s.at(Date.now() + 3600e3, "expire");  // absolute epoch-ms
  await s.cancel(id);  await s.list();
  // handler:
  export async function onSchedule(env, ctx) {   // ctx = { task, payload }
    if (ctx.task === "remind") (await env.SYSTEM.requestRoom()).broadcast(ctx.payload);
  }
  ```
- Use **relative** URLs in HTML (`fetch("inc")`, not `/inc`): the app is
  previewed under `/preview/`.

`AppTemplate.declares` lists the capabilities an app expects (e.g. `"store"`,
`"sql"`, `"fs"`, `"room"`, `"scheduler"`). Multiplayer apps additionally export a pure
`applyAction` reducer (+ optional `initialState`), see [Multiplayer](#multiplayer-live-pure-reducer).
Any app may also export an optional `onUpgrade(env, ctx)` to migrate its own
persisted data across a code change (limitation #10, see Multiplayer section),
and an optional `onSchedule(env, ctx)` to handle tasks it scheduled via
`requestScheduler` (runs in the sandbox with full `env.SYSTEM`).

---

## Extending it

### Add a new example / app template

1. Create `src/templates/examples/<name>.ts` exporting an `AppTemplate` that
   follows the runtime contract.
2. Register it in `src/templates/registry.ts`: that's it. It automatically
   appears in the lobby's app picker (`GET /api/templates`) and can seed rooms.

**App selection is per-room, at runtime.** Each room picks its app when it's
created: the lobby shows a picker (from `GET /api/templates`) and `POST
/api/create?room=<id>` `{template}` seeds that room from the chosen template before
you enter it. `DEFAULT_TEMPLATE_ID` in `src/templates/registry.ts` is now only the
FALLBACK, used when a room is opened without a create call, or an unknown template
is requested. (A room already in `.wrangler/` keeps its seeded code, use a fresh
id, or clear `.wrangler/`.) Seeding is lazy (`AppHost.#ensureSeeded`), not in
`onStart`, because `onStart` runs before any RPC and would always pick the default;
`create()` is idempotent and never re-seeds an existing room.

All five bundled example apps (`blackjack`, `poker`, `tictactoe`, `counter`,
`notes`) conform to the current contract; `npm run smoke -- <counter|tictactoe|
poker>` creates a fresh room with that app and checks it, you can cover all three
against ONE running dev server, no restart. `blackjack` (the default seed) and
`notes` (the filesystem demo) have no smoke check yet, test them by hand.

### Swap the AI model

The assistant's model is `CodeAssistant.getModel()` in
`src/assistant/code-assistant.ts`, set via the `ASSISTANT_MODEL` var. It is
**pinned to `@cf/moonshotai/kimi-k2.7-code`** (Moonshot AI's frontier-scale,
1T-param agentic coding model, 262k context, multi-turn tool calling, structured
outputs) in `wrangler.jsonc` `vars`, with the same id as the hardcoded fallback.
A bare `@cf/...` id hits Workers AI directly through the `AI` binding; a
`"<provider>/<model>"` slug routes through AI Gateway (see Think's `getModel`
docs). Unlike the old one-shot editor, the model here must be a reliable
**tool-caller** (it drives the agentic loop), weak models may stop early, refuse
tasks, or emit bad edit ops. Override the pin locally with a `.dev.vars` line
`ASSISTANT_MODEL="..."` (takes precedence in dev), or edit the `wrangler.jsonc`
`vars` entry for deploys.

Reasoning models (kimi-k2.7-code, glm, gpt-oss) get two guards in `beforeTurn`: a large
per-step `maxOutputTokens` (so reasoning can't crowd out the tool call and end
the step with `finishReason:"length"` before an edit is emitted) and a
`reasoning_effort` (default `medium`, tunable via the `ASSISTANT_REASONING_EFFORT`
var), low under-plans and invites lazy refusals, high burns tokens.

### Add a new resource (e.g. R2 for images)

The **broker is the growth point**. Adding a resource type is additive:

1. Bind the resource to the host in `wrangler.jsonc` (if it needs a binding).
2. Add one `request*` method to `CapabilityBroker` that returns a scoped
   capability stub, prefixed by `props.instance` for isolation. `requestBlobStore`
   (R2), `requestFetch` (mediated egress), `requestRoom` (app-driven realtime, which
   reaches AppHost's live sockets by RPC), `requestScheduler` (a dedicated
   AppScheduler DO + alarm running the app's `onSchedule`) and `requestSql` (a
   dedicated per-room AppSql DO with its own SQLite) are shipped examples.
   All broker hooks are now implemented, no reserved stubs remain.
3. Add an entry to `src/capabilities/manifest.ts`. This is the SINGLE source of
   truth: the `declares` vocabulary, the AI assistant's system-prompt contract,
   and the human docs all render from it, so a new capability is taught to the AI
   and documented without editing three files. (Mark it `available: false` while
   still reserved, it's documented but not yet offered to the AI.)

The app contract and runner don't change, apps just call
`env.SYSTEM.requestBlobStore(...)` / `env.SYSTEM.requestFetch(...)`.

The **filesystem capability** (`requestFilesystem` → `ScopedFilesystem`) is a
real, shipped instance of exactly this pattern: it mirrors the
`requestStore` → `ScopedStore` chain, adds path sanitisation + a namespace
prefix in the trusted `ScopedFilesystem`, and delegates (directly, not via
AppHost) to `@cloudflare/dofs` running inside the **`AppData` DO**'s isolated
SQLite, so it needed no new binding beyond the `APP_DATA` DO itself.

### Multiplayer (live: pure-reducer)

`src/realtime/coordinator.ts` is the realtime engine. It owns everything an
untrusted app must NOT be handed directly, WebSocket connections, presence,
seat assignment, persistence and broadcast, and drives the app's **pure**
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
broadcast (after an initial `{type:"welcome", seat}`). It must also handle the
reserved `{type:"reload"}` frame by calling `location.reload()` (see
[Live reload](#live-reload)). The example `tictactoe` app shows the whole pattern
end-to-end; `blackjack` (the default seed) and `poker` add hidden information on
top (see below).

Seats are opaque player slots the coordinator assigns bound to a stable player
`token`: a brief disconnect keeps your seat, and a departed player's seat is only
reclaimed when another player needs it. **Seat names are declared by the app**
via the optional `seats` export (the framework core names none); no `seats`
export means everyone is a spectator (`ctx.seat === null`).

#### Live reload

The realtime channel normally carries only game **state**, so a code change
(AI edit, manual save, rollback) wouldn't reach clients already running the old
page. On every successful **promote**, `AppHost` broadcasts a `{type:"reload"}`
frame to all connected clients; the app page reloads and re-fetches the new
version. Broadcasts are **debounced** (`RELOAD_DEBOUNCE_SECONDS`, 0.75 s) so a
multi-promote AI turn triggers a single reload on the final good version, and a
**failed** build (not promoted) never reloads anyone. Realtime app pages opt in
by handling the frame (the bundled templates do; the assistant's system prompt
tells AI-authored pages to keep it).

The debounce is backed by a **Durable Object alarm** (`this.schedule(...,
"flushReload", ...)`), not a `setTimeout`: a bare timer would be lost if the DO
hibernated mid-window and silently drop the reload, whereas the alarm survives
hibernation. Each promote cancels the pending alarm and re-arms it.

#### Live status (editor)

The room's **Edit** chrome shows the live version + build status. To keep those
current when the version changes *without a local action*, e.g. the AI promotes
a build, or **another tab** edits the same room, `room.html` opens a read-only
WebSocket to `/agents/app-host/<room>?spectate=1` and watches AppHost's synced
state over the Agents `cf_agent_state` protocol (a frame on connect and on every
`setState`). The `?spectate=1` flag tells `AppHost` to treat the connection as a
pure state subscriber: it **skips the realtime coordinator**, so the editor takes
**no game seat** and is excluded from game broadcasts/presence. The on-load
`/api/state` fetch remains the fallback if the socket never opens.

#### Version-history GC

Every edit adds a version, so unbounded history would grow the DO's SQLite
forever. `AppHost` sweeps it on a recurring **alarm**, `onStart` arms
`this.scheduleEvery(VERSION_GC_INTERVAL_SECONDS, "gcVersions")` (idempotent, so
it stays a single daily schedule across DO wakes), keeping the newest
`VERSION_HISTORY_KEEP` (50) versions plus the currently-active one and pruning the
rest (`schema.pruneVersions`).

#### Player identity (reconnection)

A player's seat is bound to the `token` on the WebSocket URL, so returning with
the same token resumes the same seat. `room.html` gives **each tab its own id**
and writes it into that tab's address bar (`?player=<id>`, via `replaceState`):

- **Multiple tabs** of one browser ⇒ different ids ⇒ **different players**.
- **Reload / reopen-closed-tab** restores the URL (and id) ⇒ **resumes the seat**.
- A freshly-typed or **shared** room link has no `player=` ⇒ a new id ⇒ a new
  player. ("Copy link" intentionally omits `player=`, so invites never clone your
  seat.)
- Bundled app pages fall back to a per-browser `localStorage` id when opened
  directly (no `player=` forwarded), and honor an explicit `?player=` override.

### Multiplayer (asymmetric views: hidden information)

By default every client receives the **same** state broadcast. Some games need
each player to see something **different**, your poker hand is yours alone. An
app opts in with one more pure export, `view(state, ctx)`:

```js
export function view(state, ctx) {   // ctx = { seat, playerId }
  // Return only the slice THIS viewer may see. The reducer keeps one full
  // authoritative state (deck, everyone's cards); `view` is the single place
  // that decides visibility, hide the rest here.
  return projectedStateForThisSeat;
}
```

The coordinator projects the state **per connection** (batched into one
sandboxed call via `runner.project()`) and sends each client its own
`{type:"state"}` frame, so secret data never leaves the server. Absent a `view`
export, the full state is broadcast to everyone (symmetric apps like tic-tac-toe
are unchanged). The `blackjack` example (the default seed) demonstrates the
pattern: the dealer's hole card stays hidden from everyone until the dealer plays.
The `poker` example goes further, each player sees only their own hole cards
until showdown.

> Concurrency: the coordinator **serializes** state transitions (a promise
> chain), so two players acting at the same instant can't race and clobber each
> other's writes (a real hazard, since the DO input gate releases during the
> sandbox RPC `await`).

> **Follow-up (poker):** the `poker` example uses a single main pot. Proper
> **side pots / short all-in** handling (when a player is all-in for less than a
> later bet) is intentionally out of scope for now, and is the natural next step
> for that example. It's an app-level change (`applyAction`/`view` in
> `src/templates/examples/poker.ts`), no framework core change needed.

**App-driven realtime (`broker.requestRoom()`), now shipped.** Alongside the
pure-reducer path, an app can get a `Room` capability and PUSH to its connected
clients from its own code: `room.broadcast(msg)` (all clients), `room.send(seat,
msg)` (one seat), `room.presence()`. It's the second consumer of this same engine:
the app still holds no socket; `ScopedRoom` reaches AppHost's live connections
by RPC and delivers each message as a `{ type: "app", data }` frame (distinct from
the coordinator's `welcome`/`state`/`reload` frames). The two models compose: use
the reducer for authoritative turn-by-turn state, and `requestRoom` when an update
originates OUTSIDE a WebSocket action (an HTTP endpoint, a webhook, a scheduled
task). App-driven state stays in `requestStore`, not the coordinator's `__room__`.

Realtime state lives in the AppHost's `app_data` table under a reserved
`__room__` scope (not in the synced pointer state). When the app's live version
changes, the state is **preserved across the edit** rather than wiped: the
coordinator KEEPS the stored state if it still probes compatible with the new
code, else runs the app's optional pure `migrate(oldState, oldStateVersion)` and
keeps that if IT probes compatible, and only otherwise resets to `initialState`
(clearing seats). So a cosmetic/logic edit no longer resets an in-progress game;
a breaking state-shape change either migrates or resets. (See the state-
preservation flow in `src/realtime/coordinator.ts` `#ensureFreshState`.)

That `migrate` only reshapes the realtime `__room__` state. An app's OWN persisted
data, whatever it wrote via `requestStore`/`requestFilesystem`/`requestBlobStore`,
is migrated by a separate optional export, `onUpgrade(env, ctx)` (limitation
#10). Unlike `migrate` it is NOT pure: it receives the same `env` as `fetch`, so
it can read and rewrite that data. `AppHost` runs it once per FORWARD promote
(right after a successful build), tracking the last-upgraded version in the
`__upgrade__` scope; it's skipped on rollback/first seed and must be idempotent.
If it throws, the new code stays live but the app is flagged `status:"error"` and
the upgrade retries on the next promote. (See `AppHost.#runDataUpgrade`.)

---

## HTTP API (host worker)

| Method + path | Body | Returns |
| --- | --- | --- |
| `GET /api/templates` |, | `{ templates: [{ id, label, declares, default }] }`, the app catalog for the lobby picker (no room / DO touched) |
| `POST /api/create` | `{ template? }` | seed the room from a chosen template (runtime app selection) → `{ room, templateId, created }`; idempotent (existing room unchanged) |
| `GET /api/state` |, | `{ activeVersion, status, templateId, lastError }` |
| `GET /api/files` |, | `{ files: [{ path, content }] }` |
| `GET /api/versions` |, | `{ versions: [{ id, ts, note }] }` |
| `POST /api/files` | `{ files, note? }` | `{ version }` |
| `POST /api/reset` |, | `{ version }` |
| `POST /api/rollback` | `{ version }` | `{ ok: true }` |
| `GET /api/egress` |, | `{ allow: string[] }` (the app's egress allowlist) |
| `POST /api/egress` | `{ allow }` | `{ allow }` (host allowlist for `requestFetch`) |
| `GET /api/limits` |, | `{ limits }` (resolved per-app resource limits) |
| `POST /api/limits` | `{ limits }` | `{ limits }` (override any subset; clamped, merged, persisted) |
| `GET /api/secrets` |, | `{ secrets: [{ name, readable }] }` (**names only, never values**) |
| `POST /api/secrets` | `{ name, value?, readable?, delete? }` | set/overwrite (`{ secret }`) or delete (`{ deleted }`) a secret |
| `GET /api/email` |, | `{ policy }` (allowed senders/recipients + default sender for `requestEmail`) |
| `POST /api/email` | `{ policy }` | set the email policy (`allowedFrom`, `allowRecipients`, `defaultFrom`, `fromName`) → `{ policy }` |
| `GET /api/resources` |, | one snapshot for the **Resources panel**: the capability catalog (from the manifest) + current egress / limits / secrets(names) / email config + email usage |
| `ANY /preview/<path>` |, | the app's response, **streamed** (HTML gets `<base>` injected) |
| `WS /agents/app-host/<room>` |, | realtime channel for multiplayer apps (see Multiplayer) |
| `WS /agents/code-assistant/<room>` |, | AI coding assistant chat (Agents `cf_agent_chat_*` protocol) |

AI editing has no HTTP route: it is a chat over the `/agents/code-assistant/<room>`
WebSocket, driven by the `CodeAssistant` (Think) Durable Object.

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
  it), but it is NOT promoted, the live pointer stays on the last version that
  built, and `status` flips to `error` with the build message in `lastError`.
- **The AI assistant is `@cloudflare/think` (EXPERIMENTAL).** It runs as a
  separate per-room Durable Object (`CodeAssistant`) and drives an agentic loop
  over host-side tools. It's a heavy dependency (`ai` v6, NOT v7, `zod` v4,
  `@cloudflare/shell`, codemode, just-bash; measured ~1.46 MB gzip for the whole
  host worker, well under the 3 MB Free / 10 MB paid limits, so size is NOT a
  ceiling risk; Think dominates the bundle's composition + cold-start parse, not
  the limit). I install the minimal set: no React / `@cloudflare/ai-chat` (the
  Chat panel is vanilla JS), and Think's workspace/bash/code-execution tools are
  gated off. `Think`'s peer `agents >=0.17.1` is satisfied by the pinned `0.17.3`.
- **Code Mode (`@cloudflare/codemode`).** The assistant also has a `code_mode`
  tool that lets the model write ONE orchestration script over the read/edit
  tools, fewer round-trips for mechanical multi-step edits. The script runs in
  its own isolated Dynamic Worker (no egress, no bindings; only tool-dispatcher
  RPC back to the build-gated tools), so it preserves the sandbox boundary. I use
  `@cloudflare/codemode` directly (not Think's workspace-coupled execute tool) so
  I control exactly which tools the sandbox can reach. Reuses the `LOADER`
  binding, no new config.
- **Context management is Think's, not hand-rolled.** A long, tool-heavy chat can
  balloon the transcript until the model call stalls before emitting a tool call
  (the turn appears to "do nothing", and since history only grows, every later
  turn fails the same way). Instead of a custom truncation pass I use Think's
  built-ins: deterministic **compaction** (`configureSession` →
  `onCompaction(createCompactFunction(...))` + `compactAfter(CONTEXT_TOKEN_BUDGET)`,
  ~120k tokens; the summary is a fixed "re-read the files" marker so it costs no
  model call and can't no-op), `contextOverflow` (proactive compaction + a
  reactive compact-and-retry backstop), `mediaEviction` (drops big aged tool-output
  blobs), and `chatRecovery` (durable fiber so a deploy/eviction/stall mid-turn
  resumes instead of stalling). All operate on the assistant's OWN transcript
  (Session/DO SQLite), they never touch app files or the app sandbox, so they
  don't affect isolation. Compaction relies on the app being re-readable, which
  the system prompt already instructs.
- **App runtime data lives in the `AppData` DO (limitation #3).** The key/value
  store and the dofs filesystem run in `AppData` (its own isolated SQLite, one per
  room), reached DIRECTLY by the ScopedStore/ScopedFilesystem stubs, two hops,
  never through AppHost, so storage traffic doesn't funnel through the code DO.
  The broker still mediates every call. dofs is bundled (tree-shaken) into the
  worker and executes only in the `AppData` DO's isolate. This replaced an earlier
  `AppStorageFacet` facet (reached via `AppHost.ctx.facets.get`, 3 hops); `AppData`
  is a new SQLite DO (migration `tag: "v3"`). Rooms created before this change
  won't carry their data across, use a fresh room id (or clear `.wrangler/`).
- **Dynamic Worker logs need the tail worker.** A Dynamic Worker runs in its own
  context, so its `console.log()`/exceptions aren't captured automatically.
  `DynamicWorkerTail` (attached in `runner.ts`) forwards them into Workers Logs
  tagged by `workerId`; it relies on `observability.head_sampling_rate: 1` in
  `wrangler.jsonc`.
- **Tool-driven, line-addressed edits.** `apply_line_edits` (the fast path)
  passes structured ops to `applyEdits` (applied bottom-up so line numbers stay
  valid; validates bounds/overlap). `read_file` shows 1-indexed line numbers so
  the model can cite exact positions. Needs a reliable tool-calling model.
- **Self-heal is the loop.** A write tool returns the build outcome; on failure
  the model reads the error and makes a follow-up edit, no separate retry loop.
  Latency: a simple change is ~1 fast tool call; complex changes run several
  sequential model round-trips (slower than the old one-shot, but far more
  capable). Weak models may stop early, pick a solid `ASSISTANT_MODEL`.
- **Rendered vs Raw.** The preview renders HTML in a sandboxed iframe; relative
  URLs work via an injected `<base href="/preview/">`. Absolute app URLs (`/x`)
  will not reach the app, the AI is steered toward relative URLs.
- **Live reload needs the app page to handle `{type:"reload"}`.** The bundled
  templates do; a room whose app was seeded before this was added won't reload
  others until its page includes the handler (use a fresh room, or ask the
  assistant to add it). Non-realtime apps (e.g. `counter`, no WebSocket) have no
  channel to receive it, reload them manually.
- **Player identity is per-tab, in the URL.** `room.html` mints an id and stores
  it in the address bar (`?player=`). A shared/typed room link has none, so it's
  a new player; multiple tabs are distinct players; reload/reopen resumes. Old
  `.wrangler/` rooms may still carry the previous `sessionStorage`/`localStorage`
  scheme until reseeded.
- **Local state persists** across `wrangler dev` restarts (Durable Object
  storage in `.wrangler/`), so your versions survive restarts.

---

## Hardening status

This started as a learning prototype; several rough edges have since been
hardened. The list below tracks that work (the `#N` ids are referenced from
code comments and `AGENTS.md`). It is **still not production-ready**, the
outstanding items below (auth, quotas) matter before any real exposure.

**Resolved**

| # | Limitation | Resolution |
| --- | --- | --- |
| #1 | An edit wiped in-progress realtime state | State is preserved across edits: KEEP → `migrate` → RESET, gated by a sandboxed `probe` (`coordinator.#ensureFreshState`). |
| #2 | `get()+put()` races lost updates | Atomic `incr`/`cas` run in one DO method under the input gate (`ScopedStore`, `AppData`). |
| #3 | Storage funneled through the code DO (3 hops) | App data moved to a top-level `AppData` DO reached directly by the scoped stubs (2 hops, no funnel). |
| #4 | Bundler ran on the request path | Builds are precompiled on promote and persisted (`schema.builds`); the run path skips esbuild on a cold cache. |
| #7 | Apps could only reach a KV store | Added a filesystem (dofs), an R2-backed blob store, mediated allowlisted egress, use-not-read secrets, mediated transactional email, app-driven realtime (`requestRoom`: broadcast/send/presence), a task scheduler (`requestScheduler` + the `onSchedule` export, backed by a per-room `AppScheduler` DO + alarm), and a private relational SQL database (`requestSql`: exec/query/first/run, backed by a per-room `AppSql` DO with row + DB-size caps), all via the broker; the catalog is the single-source `capabilities/manifest.ts`. |
| #9 | A self-imposed no-backtick rule made edits fragile | Dropped it: code is bundled (esbuild), so template literals are the preferred, robust way to build the HTML page. |
| #10 | App-owned data had no migration path | Optional `onUpgrade(env, ctx)` runs once per forward promote to migrate the app's own store/fs/blob data. |
| #12 | Mediated egress could be SSRF'd via redirects + buffered unbounded | `ScopedFetcher` now follows redirects MANUALLY, re-validating every hop's host against the allowlist, and caps the response by size + a timeout (both configurable). |

**Partially resolved**

| # | Limitation | Done / Remaining |
| --- | --- | --- |
| #5 | No quotas / resource limits / rate limiting | **Done:** per-run `limits.cpuMs`/`subRequests` on the Dynamic Worker run; mediated-fetch timeout + max-bytes + redirect caps; per-value + per-app store byte quotas (`AppData`); a per-app daily email cap (`emailPerDay`); a pending-scheduled-tasks cap (`maxScheduledTasks`, + a 1s delay/interval floor). All GENEROUS by default and per-app configurable via `GET`/`POST /api/limits` (`src/config/limits.ts`, trusted `__limits__` scope). **Remaining:** request-rate throttling (per-room/IP) is still absent. |

**Outstanding**

| # | Limitation | Notes |
| --- | --- | --- |
| #6 | No authentication | Rooms are unauthenticated and their ids are guessable; anyone with a room id can view/edit its app. |
| #8 | Build-gate ≠ correctness | A version can compile yet be logically broken; the build check catches syntax/type errors only. |
| #11 | Operational ceilings | Preview-grade APIs (Worker Loader, `worker-bundler`), the assistant's bundle parse cost, and model reliability all cap real-world use. |

### Possible next steps

Non-blocking improvements I've noted (see `docs/cloudflare-sdk-usage.md` for the
full architecture write-up):

- **Request-rate throttling (closes #5).** Per-run CPU/subrequest, store, email,
  and SQL caps are in place; a per-room/IP request-rate limit is the one remaining
  quota. The Workers Rate Limiting binding is the natural fit.
- **Route the assistant through AI Gateway.** Think already supports it (a
  `"<provider>/<model>"` slug routes through AI Gateway; I currently use a bare
  `@cf/...` id that hits Workers AI directly), so adopting it would add response
  caching, rate-limiting, and cost/latency observability on the agentic loop.
- **Bundle weight is dominated by Think.** The host worker is ~1.46 MB gzip (well
  under the 3 MB Free / 10 MB paid limit); most of it is Think's transitive deps
  (`ai` v6, `@cloudflare/shell`, just-bash) plus codemode. If cold-start parse cost
  ever matters, split `CodeAssistant` into its own Worker service.
