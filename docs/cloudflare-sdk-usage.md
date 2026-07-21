# Mutable App Framework — Architecture & Cloudflare SDK Usage

This document explains our central design idea — **the program lives as
data** — and then walks each Cloudflare technology, listing what we use,
what we don't, and why. It reflects the codebase *after* moving all app runtime
data into a dedicated top-level **`AppData` Durable Object** (which replaced an
earlier Durable Object *Facet* — see §"App runtime data" for that history) and
adding Dynamic Worker Tail observability, plus the later additions of **Code
Mode** (a second Dynamic Worker sandbox for the assistant's orchestration
scripts), Think's **built-in context management** (compaction / overflow /
recovery), and **alarm-based scheduling** in `AppHost` (debounced live-reload +
version-history GC).

---

## 1. The core idea: the program lives as data

In a conventional Cloudflare app, **the source of truth for code is the
deployment**. You `wrangler deploy`, and the code baked into the Worker is what
runs. Code is static; only data changes at runtime.

We **invert that**:

> An app's source code lives as **rows in SQLite inside a Durable Object** —
> versioned, mutable at runtime, and run without any redeploy.

Editing the app never touches the deployed Worker. It writes new rows. The next
request bundles those rows into an isolated Dynamic Worker and runs them. Runtime
self-modification is the entire premise.

### Where the truth lives

Each room has its own `AppHost` Durable Object (keyed by room id via
`getAgentByName`). Inside it, two SQLite tables (`src/agent/schema.ts`) are
authoritative for **code**:

- `versions(id, ts, note)` — every version ever saved
- `files(version, path, content)` — the actual code bytes, per version

So the source of truth is **per-room**: independent code and history per room.

### SQL is truth; agent state is only a pointer

The pivotal rule (invariant #3 in `AGENTS.md`):

```
this.setState  →  { activeVersion, status, templateId, lastError }   ← a POINTER
SQLite (files) →  the actual code bytes                              ← the TRUTH
```

Agent `state` is **broadcast to every connected client** by the Agents SDK. If
code lived in state, every edit would leak source to all browsers and couple code
to the sync channel. So state holds only a tiny pointer — which version is live
and whether it builds — while the authoritative content stays in SQL, fetched
explicitly via RPC.

### The truth is gated — one write path, with a build check

The live version only advances through a single door: `AppHost.setFiles`
(`src/agent/app-host.ts`). It:

1. Bundles/compiles the candidate code (`runner.bundleApp`).
2. **Builds** → saves the version *and* promotes the live pointer (auto-promote).
3. **Fails** → saves the version for inspection but does **not** promote; the
   pointer stays on the last good version and `status` becomes `error`.

Reads always return the last version that built, so a broken edit can never
corrupt what's live.

### One sentence

> `AppHost`'s SQLite is a tiny, per-room, version-controlled repository;
> `setFiles` is its only commit path with a build-check as a pre-commit hook;
> agent `state` is just the "HEAD" pointer telling everyone which commit is live.

Every other component — the Dynamic Worker runner, the AI assistant, the
capability broker, the realtime coordinator — is a **consumer** of that truth,
never a second owner of it. That single-owner, gated-write discipline explains
nearly every SDK decision below.

### Two kinds of truth (why app data lives in its own DO)

Code and app *runtime data* have opposite lifecycles:

| | Code (`versions`/`files`) | App runtime data |
|---|---|---|
| Nature | Versioned artifact | Live mutable state |
| Written by | The build-gate (`setFiles`) | The running app, per request |
| Rolled back? | Yes | No — it's "now" |
| Owner | `AppHost` supervisor SQLite | **A dedicated `AppData` DO's isolated SQLite** |

Because they differ, they live in different stores: **code stays in `AppHost`;
app runtime data lives in a separate top-level `AppData` Durable Object** (see
§"App runtime data" — that section also records why this was first a *facet* and
why we later promoted it to a top-level DO).

---

## 2. Resource-by-resource usage

Each resource below is tagged **used**, **partial/reserved**, or **not used**.

### Agents SDK (`agents`) — core backbone (used)

**Used:** `Agent` base class (`AppHost`), `routeAgentRequest`, `getAgentByName`,
agent state (as a pointer, broadcast to clients as `cf_agent_state` — the editor
chrome subscribes read-only via a `?spectate=1` WS to watch the live version/status
without polling), WebSocket lifecycle
(`onStart`/`onConnect`/`onMessage`/`onClose`), `broadcast`/`getConnections`,
`this.sql`, **scheduling** (`this.schedule`/`this.scheduleEvery`/`cancelSchedule`,
backed by DO alarms).

**Unused:** MCP (tools are local), React hooks/`useAgent` (hand-rolled vanilla-JS
`cf_agent_chat_*` client to avoid React bundle weight), `agent-tools` sub-agent
dispatch (assistant→AppHost is plain RPC), `hono-agents` (plain `fetch`), Wrangler
cron triggers (scheduling is DO-alarm based, not a Worker-level cron).

**Why:** Ideal substrate — per-room DO isolation, built-in WebSockets, SQLite in
one place. We lean on the primitives that support "code as gated data" and
skip convenience layers that add bundle weight or don't fit a local-tool model.
Scheduling started out unused (realtime is event-driven) but two housekeeping
tasks turned out to need *durable* timers that survive DO hibernation: the
debounced live-reload broadcast (`this.schedule(0.75, "flushReload", …)`, cancelled
and re-armed on each promote) and the recurring version-history GC
(`this.scheduleEvery(24h, "gcVersions")`, idempotent so it stays a single schedule
across wakes). A plain `setTimeout` would be silently dropped if the DO slept
mid-window — the alarm is the idiomatic fix.

### Dynamic Workers (`worker_loaders` + `@cloudflare/worker-bundler`) — the sandbox (used)

**Used:** `env.LOADER.get()`, `createWorker()`, custom `SYSTEM` capability-binding
injection, `globalOutbound: null` (no network egress), content-hash warm caching,
**Tail Workers** (per-run observability — see below), and a **second sandbox for
Code Mode**:
`@cloudflare/codemode`'s `DynamicWorkerExecutor({ loader: this.env.LOADER })` runs
the assistant's orchestration scripts in their own Dynamic Worker (see the Codemode
section).

**Unused:** custom resource limits (`limits.cpuMs`/`subRequests`) on the dynamic
run.

**Why:** This *is* how untrusted app code runs — isolate-level security,
millisecond cold starts, per-request fan-out. `globalOutbound: null` plus a single
capability binding is the whole security posture (invariants #1, #2). There are now
**two** consumers of the Worker Loader with the same posture: the untrusted *app*
sandbox (`runner.ts`, which injects the `SYSTEM` broker) and the assistant's
*orchestration* sandbox (Code Mode, which injects nothing — only tool-dispatcher
RPC). Both keep `globalOutbound: null` and hand out no real bindings.

Beyond serving `fetch`, the app sandbox also exposes a framework-injected adapter
(a second `Logic` entrypoint bundled alongside the app) that invokes the app's
optional exports: the pure realtime functions `applyAction`/`initialState`/
`view`/`seats`, the state-preservation `probe`/`migrate` (limitation #1), and —
newest — `onUpgrade(env, ctx)` (limitation #10), which runs with the app's own
`SYSTEM` broker to migrate the app's persisted store/fs/blob data across a code
change. See `runner.ts` (`reduce`/`project`/`probe`/`migrate`/`runUpgrade`).

Because `@cloudflare/worker-bundler` (esbuild) ALWAYS runs before the app
executes, apps are free to use modern JS — in particular **template literals
(backticks + `${}`)**, which is the preferred way to build the HTML page
(limitation #9). The example seeds under `templates/examples/` avoid inner
backticks only because their source is embedded as a string inside `.ts` files;
that is an embedding quirk of the seeds, not a runtime constraint.

### `@cloudflare/think` — used, deliberately trimmed

**Used:** `Think` base (`CodeAssistant`), `getModel`/`getSystemPrompt`,
`getTools()` with AI SDK `tool()`/`ToolSet`, `maxSteps`, `configureSession` +
writable memory context block, Session FTS5 history, `beforeTurn`→`TurnConfig`
tool-gating, the `cf_agent_chat_*` WS protocol, and the full **context-management
stack**: deterministic compaction (`configureSession` →
`onCompaction(createCompactFunction(...))` + `compactAfter(CONTEXT_TOKEN_BUDGET)`),
`contextOverflow` (proactive + reactive compaction), `mediaEviction` (drops big
aged tool-output blobs), `chatRecovery` (durable fiber for mid-turn resume), and
`classifyChatError` → `defaultContextOverflowClassifier`.

**Unused (explicitly disabled):** built-in workspace/`bash` tools
(`workspaceBash = false`), Think's own code-execution tool (we use
`@cloudflare/codemode` *directly* instead — see below), Agent Skills, scheduled
tasks, messengers, extensions, sub-agent dispatch.

**Why:** We wanted the hard parts — the agentic loop, streaming, persistence,
per-room memory, and now context management (a long, tool-heavy transcript would
otherwise stall the model before it emits a tool call) — but Think's built-in
*tools* write to the *agent's own* SQLite. The truth here lives in a **different
DO** (`AppHost`) behind a build-gate, so those tools are turned off and replaced
with custom tools that route through `AppHost` RPC (invariant #5). The
context-management features are the opposite case: they operate purely on the
assistant's *own* transcript (Session/DO SQLite), never touching app files or the
app sandbox, so adopting them costs nothing on the isolation ledger. Note Think's
execute tool is still disabled — Code Mode is wired up *directly* so we control
exactly which tools reach its sandbox (see below).

### Workers platform — modern stack (used)

**Used:** module `fetch` handler, `WorkerEntrypoint` + Workers RPC
(`CapabilityBroker`, `ScopedStore`, `ScopedFilesystem`, `DynamicWorkerTail`),
Static Assets with `run_worker_first`, SQLite-backed DOs, Workers AI (`AI`
binding), WebSockets, **Workers Logs** (`observability`, now
`head_sampling_rate: 1`), `nodejs_compat`.

**Unused:** KV, D1, Queues, Workflows, Vectorize, Browser Rendering, cron
triggers. R2 is a **reserved** broker hook (`requestBlobStore`), not bound.

**Why:** `WorkerEntrypoint` RPC is the capability-security mechanism — how an
untrusted app gets scoped powers without touching a real binding (invariant #2).
No persistence services are bound because everything lives in DO SQLite by design.

### App runtime data — a dedicated top-level `AppData` DO (used)

**Used:** a top-level Durable Object `AppData` (`src/agent/app-data.ts`), one per
room id, with its **own isolated SQLite**. **Both** kinds of app runtime data
live there: the key/value store (`env.SYSTEM.requestStore`) *and* the filesystem
(`env.SYSTEM.requestFilesystem`, backed by dofs). The `ScopedStore` /
`ScopedFilesystem` capability stubs reach it **directly** —
`env.APP_DATA.get(idFromName(instance))` — so the data path is exactly two hops
(app → scoped stub → `AppData`) and never passes through `AppHost`.

**Not used:** letting *untrusted* app code define the DO class directly. The class
is **trusted framework code**; the untrusted app still reaches it only through the
broker, which validates/quota-checks/path-sanitises every call.

**Why:** Code and runtime data have opposite lifecycles. A separate DO gives
runtime data its own isolated SQLite (blast-radius isolation — a chatty app can't
bloat version history), its own input gate (app writes don't serialize behind code
ops or the realtime coordinator), and platform-enforced isolation. **Host-side
mediation is preserved**: the broker's scoped stubs keep *policy*; the DO adds
*isolation*. Only the realtime coordinator's own state (the `__room__` scope) and
the trusted egress allowlist (the `__egress__` scope) remain in `AppHost`'s SQLite,
since they're framework state, not app data.

#### History: first a Facet, then a top-level DO (limitation #3)

This data first lived in a **Durable Object *Facet*** — `AppStorageFacet`, a child
DO reached via `AppHost`'s `this.ctx.facets.get(...)`. We reached for facets
because they are *the* idiomatic way to give a DO a second, isolated SQLite: a
facet runs beneath a parent DO with its own storage and input gate, and the
platform enforces that neither can read the other's database. That got us the
isolation we wanted (app data off `AppHost`'s code store) with a trusted class we
still fronted with the broker.

The catch is **structural**: a facet is only reachable *through its parent*. There
is no way to address a facet by name from outside — you must call the parent DO,
which then calls `ctx.facets.get`. So every `store.get` / `fs.read` was **three
hops**: `app → ScopedStore → AppHost → AppStorageFacet`. That reintroduced exactly
the coupling the facet was meant to remove — `AppHost` (the single per-room code +
realtime DO) sat on the hot path of *every* storage call, so storage traffic
contended with code reads and the realtime coordinator on `AppHost`'s single
input gate. This is limitation **#3** ("single-DO funneling + 3-hop storage").

Promoting the same logic to a **top-level `AppData` DO** keeps every benefit the
facet gave us (isolated SQLite, own input gate, platform isolation, broker-kept
policy) while removing the forced middle hop: a top-level DO *can* be addressed by
name, so `ScopedStore`/`ScopedFilesystem` call it directly (**two hops**) and
`AppHost` leaves the storage path entirely. The class body is essentially
unchanged — it moved from `src/agent/facet/entry.ts` (bundled to a string for the
Worker Loader) to `src/agent/app-data.ts` (a normally-bundled DO), so we also
dropped the `build:facet` esbuild step and the loader indirection.

#### Why NOT a facet — the explicit decision rule

A facet and a top-level DO give the **same isolation** (own SQLite, own input
gate, platform-enforced mutual isolation). They differ on **one axis only:
addressability**. That single difference is the whole decision:

- A **facet has no name.** It is reachable *only* through its parent
  (`parent.ctx.facets.get(...)`). Any external caller must therefore go
  **through the parent**.
- A **top-level DO has a name.** Any binding holder can reach it directly with
  `NS.get(idFromName(...))` / `NS.getByName(...)`.

So the rule we now apply to every "second isolated store" is:

> **Who calls it?**
> • Only the parent, and the store is conceptually part of the parent → **facet**
>   (parent-private sub-store; the parent hop is free because the parent was
>   going to be on the path anyway).
> • Anyone *other* than the parent — especially something on a hot path that must
>   NOT wake/serialize the parent → **top-level DO** (a facet would force that
>   caller through the parent, turning it into a funnel = limitation #3).

Applying the rule to this project, **none** of the app-runtime DOs qualify as a
facet, and all three are top-level for the same reason:

| DO | Who reaches it | If it were a facet of AppHost | Verdict |
|----|----------------|-------------------------------|---------|
| `AppData` | `ScopedStore`/`ScopedFilesystem`, from the app request path | every `store.get`/`fs.read` serializes on AppHost's input gate, contending with code + realtime | **top-level DO** |
| `AppSql` | `ScopedSql`, from the app request path | every query funnels through AppHost | **top-level DO** |
| `AppScheduler` | `ScopedScheduler` + its own DO alarm | tasks + alarm callbacks funnel through AppHost | **top-level DO** |

The invariant that makes this decisive: **AppHost is the single per-room code +
realtime coordinator DO, and it must stay off the storage hot path** (limitation
#3). Anything an app touches per-request (store, SQL, scheduler) is reached by a
capability stub that must NOT route through AppHost — which rules out a facet by
construction. `CodeAssistant` is separate for an orthogonal reason (it `extends
Think`, single-inheritance vs AppHost's `extends Agent`, and is routed to directly
by name over its own WS route — a facet couldn't be routed to independently).

The general lesson: **facets are the right tool ONLY when the second store is
genuinely subordinate to one parent and only that parent needs it; the moment a
different caller needs it directly, use a named top-level DO so the parent never
becomes a funnel.**

#### Current platform status (checked 2026 — facets are no longer the public pattern)

Since we made this migration, Cloudflare has effectively converged on our
conclusion. As of the current docs:

- **`ctx.facets` is gone from the public [DurableObjectState API](https://developers.cloudflare.com/durable-objects/api/state/)**, and "facet" appears **zero** times in the Durable Objects docs index (`llms.txt`). Facets still exist in the runtime (the Agents SDK uses them internally — `cf_agents_is_facet`), but they are no longer a recommended, documented public API.
- The replacement is **`ctx.exports`** (behind the `enable_ctx_exports` compat flag): *"for each top-level export that extends DurableObject … `ctx.exports` automatically contains a Durable Object namespace binding."* In other words the platform's answer to "give a DO a second isolated SQLite" is now exactly what we did — **a named top-level DO** — with the added convenience that it can be reached via an auto-generated loopback namespace binding, no explicit `wrangler` binding required. This is essentially "facets, but addressable by name," the very thing recommendation #4 below asked for.

**Possible future simplification (not yet adopted):** enable `enable_ctx_exports`
and reach `AppData`/`AppSql`/`AppScheduler` via `ctx.exports` loopback bindings
instead of the explicit `APP_DATA`/`APP_SQL`/`APP_SCHEDULER` bindings — fewer
declared bindings, same 2-hop direct addressing. We already use the sibling
mechanism (`import { exports } from "cloudflare:workers"` in `runner.ts` /
`broker.ts`) to mint the `WorkerEntrypoint` capability stubs, so extending it to
the DO side is a small, natural step.

### `@cloudflare/dofs` (Workspace) — partial: vendored, fs-layer only

**Used:** `Database` + `initializeSchema` + `WorkspaceFilesystem` from a
**vendored** `@cloudflare/dofs` — the SQLite virtual filesystem powering the
`notes` app's filesystem capability. It runs **inside the `AppData` DO**
(`src/agent/app-data.ts`), tree-shaken to only the filesystem layer by the normal
worker bundle (it needs `nodejs_compat`, which the worker already enables). It does
not execute in the host worker's fetch isolate.

**Unused:** the full `@cloudflare/workspace` package, Container/`wsd` FUSE backend,
capnweb sync protocol, git/blob-cache machinery — all **stripped** from the
vendored build.

**Why:** We needed *only* a DO-SQLite filesystem primitive. It was valuable
enough to vendor and pin (`file:./vendor/dofs`). dofs is orthogonal to where the
storage lives: it is a *data-shape* primitive (turns SQLite into a filesystem),
so it composed cleanly on the facet's isolated storage and composes just as
cleanly now on the `AppData` DO's storage.

### Sandbox SDK (`@cloudflare/sandbox`) — not used

**Why:** We sandbox untrusted code with Dynamic Workers instead. The
hosted apps are **JS/TS Workers, not Linux processes** — no `pip`, `npm`, shell,
or container needed. Dynamic Workers give faster cold starts, cheaper tier, and
finer per-request isolation. Sandbox only wins for a full Linux userland.

### Codemode (`@cloudflare/codemode`) — used directly (the `code_mode` tool)

**Used:** `createCodeTool` + `aiTools` from `@cloudflare/codemode/ai` and
`DynamicWorkerExecutor` from `@cloudflare/codemode`, wired in
`CodeAssistant.getTools()` as a `code_mode` tool. It lets the model write ONE async
orchestration script over the read/edit tools — fewer round-trips for mechanical
multi-step edits (e.g. "insert a log line at the top of every function"). The
script runs in its **own** Dynamic Worker (`DynamicWorkerExecutor({ loader:
this.env.LOADER })`), and now that codemode is a real dependency it's pinned
explicitly in `package.json` (`^0.4.3`) rather than floating as a transitive dep.

**Not used:** Think's *execute tool* (which is codemode coupled to Think's
workspace) — we import codemode **directly** instead, and we do NOT export
codemode's `./tools/execute` (Think 0.13 doesn't ship it anyway).

**Why the direct wiring preserves the invariants (this was the whole concern in
the old version of this doc):** the earlier worry was that codemode would run code
*bypassing* `setFiles` and the build-gate. Wiring it directly is exactly what
prevents that. The executor is constructed with `{ loader }` **only** —
`globalOutbound` stays at its default `null` (no egress) and **no `env`/bindings**
are passed. The script reaches the host solely via Workers RPC to a *curated* set
of tools (`CODE_MODE_SANDBOX_TOOLS`: read/edit only — NOT `rollback`/`reset_app`,
NOT `code_mode` itself), whose `execute` bodies still run host-side and still write
through `AppHost.setFiles`. So Code Mode adds a *second orchestration sandbox* for
the assistant; the untrusted-app sandbox and the single gated write path are
unchanged (invariants #5, #11). Feeding Think's workspace/state tools into
`createCodeTool` would have handed the sandbox a filesystem it must not have — which
is precisely why we bypass Think's helper and control the tool list ourselves.

---

## 3. Suggestions

**For us:**
1. **Add custom resource limits** (`limits.cpuMs` / `subRequests`) to the dynamic
   run to bound runaway generated code, complementing `globalOutbound: null`.
2. **Consider AI Gateway** in front of the model calls for caching,
   rate-limiting, and cost/latency observability on the agentic loop.
3. **Bundle weight is dominated by Think.** dofs now bundles into the worker
   normally (it executes only in the `AppData` DO's isolate, not the fetch
   isolate), which is roughly weight-neutral versus the old facet-as-a-string
   approach. The bulk of the bundle is Think's transitive deps (`ai` v6,
   `@cloudflare/shell`, just-bash) plus codemode — the whole host worker measures
   ~1.46 MB gzip, well under the 3 MB Free / 10 MB paid limits. codemode is no
   longer *dead* weight, since the `code_mode` tool uses it directly. None of
   these can be dropped without removing the assistant or Code Mode.

**For the SDK teams (feedback):**
1. **Publish `dofs`'s filesystem layer as a supported standalone.** Clearest
   demand signal — users want the DO-SQLite VFS decoupled from
   `wsd`/capnweb/git/container. We had to vendor it.
2. **Make Think's execution deps (shell/just-bash) optional/peer.** When Think
   runs as a scoped sub-agent with custom tools, `@cloudflare/shell` + just-bash are
   pure bundle cost. (Codemode is now used directly, so it's no longer in this
   bucket — but that only worked because it's usable standalone; keeping it cleanly
   separable from Think's workspace coupling is what made the direct wiring possible
   and is worth preserving.)
3. **Support a "bring-your-own-filesystem" hook in Think.** Its biggest friction:
   it assumes the agent owns its filesystem. Users whose source of truth is
   external/gated (another DO, VCS, a build step) must disable the built-in tools.
4. **Make facets addressable by name (or document the funnel).** ✅ *Largely
   addressed by the platform since.* Facets were the natural way to give a DO a
   second isolated SQLite, but because a facet is only reachable *through its
   parent*, using one for data that many callers need turns the parent into a
   hot-path funnel (our limitation #3 — we moved off a facet to a top-level
   `AppData` DO for exactly this). A way to address a facet directly, or clearer
   guidance that facets suit *parent-private* sub-stores only, would have saved us
   the migration. As a rule: isolated sub-store used by one parent → facet;
   isolated store many callers hit directly → top-level DO. **Update:** current
   docs have dropped `ctx.facets` from the public API and introduced `ctx.exports`
   loopback namespace bindings for top-level DO classes — i.e. named, directly
   addressable second stores without boilerplate bindings. That is the "addressable
   by name" fix we wanted; the top-level-DO-with-direct-addressing pattern is now
   the documented default. See §"App runtime data" → "Current platform status".
