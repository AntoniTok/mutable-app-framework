# Mutable App Framework: Architecture & Cloudflare SDK Usage

This document explains my central design idea, **the program lives as data**,
then walks each Cloudflare technology, listing what I use, what I don't, and
why. It reflects the codebase *after* moving all app runtime data into a
dedicated top-level **`AppData` Durable Object** (which replaced an earlier
Durable Object *Facet*; see §"App runtime data" for that history) and adding
Dynamic Worker Tail observability, plus the later additions of **Code Mode** (a
second Dynamic Worker sandbox for the assistant's orchestration scripts), Think's
**built-in context management** (compaction / overflow / recovery), and
**alarm-based scheduling** in `AppHost` (debounced live-reload + version-history
GC). It also reflects the full **`env.SYSTEM` capability suite** now handed to
apps through the broker: key/value store, filesystem, R2 blob store, mediated
egress, use-not-read secrets, mediated transactional email, app-driven realtime
rooms, a task scheduler, and a private relational SQL database, all backed by
three top-level app-runtime DOs (`AppData`, `AppSql`, `AppScheduler`).

---

## 1. The core idea: the program lives as data

In a conventional Cloudflare app, **the source of truth for code is the
deployment**. You `wrangler deploy`, and the code baked into the Worker is what
runs. Code is static; only data changes at runtime.

I **invert that**:

> An app's source code lives as **rows in SQLite inside a Durable Object**:
> versioned, mutable at runtime, and run without any redeploy.

Editing the app never touches the deployed Worker. It writes new rows. The next
request bundles those rows into an isolated Dynamic Worker and runs them. Runtime
self-modification is the entire premise.

### Where the truth lives

Each room has its own `AppHost` Durable Object (keyed by room id via
`getAgentByName`). Inside it, two SQLite tables (`src/agent/schema.ts`) are
authoritative for **code**:

- `versions(id, ts, note)`: every version ever saved
- `files(version, path, content)`: the actual code bytes, per version

So the source of truth is **per-room**: independent code and history per room.

### SQL is truth; agent state is only a pointer

The pivotal rule (invariant #3 in `AGENTS.md`):

```
this.setState  →  { activeVersion, status, templateId, lastError }   ← a POINTER
SQLite (files) →  the actual code bytes                              ← the TRUTH
```

Agent `state` is **broadcast to every connected client** by the Agents SDK. If
code lived in state, every edit would leak source to all browsers and couple code
to the sync channel. So state holds only a tiny pointer (which version is live and
whether it builds) while the authoritative content stays in SQL, fetched
explicitly via RPC.

### The truth is gated: one write path, with a build check

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

Every other component (the Dynamic Worker runner, the AI assistant, the
capability broker, the realtime coordinator) is a **consumer** of that truth,
never a second owner of it. That single-owner, gated-write discipline explains
nearly every SDK decision below.

### Two kinds of truth (why app data lives in its own DO)

Code and app *runtime data* have opposite lifecycles:

| | Code (`versions`/`files`) | App runtime data |
|---|---|---|
| Nature | Versioned artifact | Live mutable state |
| Written by | The build-gate (`setFiles`) | The running app, per request |
| Rolled back? | Yes | No, it's "now" |
| Owner | `AppHost` supervisor SQLite | **A dedicated `AppData` DO's isolated SQLite** |

Because they differ, they live in different stores: **code stays in `AppHost`;
app runtime data lives in a separate top-level `AppData` Durable Object** (see
§"App runtime data", which also records why this was first a *facet* and why I
later promoted it to a top-level DO).

---

## 2. Resource-by-resource usage

Each resource below is tagged **used**, **partial/reserved**, or **not used**.

### Agents SDK (`agents`): core backbone (used)

**Used:** `Agent` base class (`AppHost`), `routeAgentRequest`, `getAgentByName`,
agent state (as a pointer, broadcast to clients as `cf_agent_state`; the editor
chrome subscribes read-only via a `?spectate=1` WS to watch the live
version/status without polling), WebSocket lifecycle
(`onStart`/`onConnect`/`onMessage`/`onClose`), `broadcast`/`getConnections`,
`this.sql`, **scheduling** (`this.schedule`/`this.scheduleEvery`/`cancelSchedule`,
backed by DO alarms).

**Unused:** MCP (tools are local), React hooks/`useAgent` (hand-rolled vanilla-JS
`cf_agent_chat_*` client to avoid React bundle weight), `agent-tools` sub-agent
dispatch (assistant→AppHost is plain RPC), `hono-agents` (plain `fetch`), Wrangler
cron triggers (scheduling is DO-alarm based, not a Worker-level cron).

**Why:** Ideal substrate: per-room DO isolation, built-in WebSockets, SQLite in
one place. I lean on the primitives that support "code as gated data" and skip
convenience layers that add bundle weight or don't fit a local-tool model.
Scheduling started out unused (realtime is event-driven) but two housekeeping
tasks turned out to need *durable* timers that survive DO hibernation: the
debounced live-reload broadcast (`this.schedule(0.75, "flushReload", …)`, cancelled
and re-armed on each promote) and the recurring version-history GC
(`this.scheduleEvery(24h, "gcVersions")`, idempotent so it stays a single schedule
across wakes). A plain `setTimeout` would be silently dropped if the DO slept
mid-window, so the alarm is the idiomatic fix.

### Dynamic Workers (`worker_loaders` + `@cloudflare/worker-bundler`): the sandbox (used)

**Used:** `env.LOADER.get()`, `createWorker()`, custom `SYSTEM` capability-binding
injection, `globalOutbound: null` (no network egress), content-hash warm caching,
**Tail Workers** (per-run observability; see below), and a **second sandbox for
Code Mode**: `@cloudflare/codemode`'s
`DynamicWorkerExecutor({ loader: this.env.LOADER })` runs the assistant's
orchestration scripts in their own Dynamic Worker (see the Codemode section).

**Unused:** custom resource limits (`limits.cpuMs`/`subRequests`) on the dynamic
run.

**Why:** This *is* how untrusted app code runs: isolate-level security,
millisecond cold starts, per-request fan-out. `globalOutbound: null` plus a single
capability binding is the whole security posture (invariants #1, #2). There are now
**two** consumers of the Worker Loader with the same posture: the untrusted *app*
sandbox (`runner.ts`, which injects the `SYSTEM` broker) and the assistant's
*orchestration* sandbox (Code Mode, which injects nothing, only tool-dispatcher
RPC). Both keep `globalOutbound: null` and hand out no real bindings.

Beyond serving `fetch`, the app sandbox also exposes a framework-injected adapter
(a second `Logic` entrypoint bundled alongside the app) that invokes the app's
optional exports: the pure realtime functions `applyAction`/`initialState`/
`view`/`seats`, the state-preservation `probe`/`migrate` (limitation #1), and, newest,
`onUpgrade(env, ctx)` (limitation #10), which runs with the app's own `SYSTEM`
broker to migrate the app's persisted store/fs/blob data across a code change. See
`runner.ts` (`reduce`/`project`/`probe`/`migrate`/`runUpgrade`).

Because `@cloudflare/worker-bundler` (esbuild) ALWAYS runs before the app
executes, apps are free to use modern JS, in particular **template literals
(backticks + `${}`)**, which is the preferred way to build the HTML page
(limitation #9). The example seeds under `templates/examples/` avoid inner
backticks only because their source is embedded as a string inside `.ts` files;
that is an embedding quirk of the seeds, not a runtime constraint.

### `@cloudflare/think`: used, deliberately trimmed

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
(`workspaceBash = false`), Think's own code-execution tool (I use
`@cloudflare/codemode` *directly* instead; see below), Agent Skills, scheduled
tasks, messengers, extensions, sub-agent dispatch.

**Why:** I wanted the hard parts (the agentic loop, streaming, persistence,
per-room memory, and now context management, since a long tool-heavy transcript
would otherwise stall the model before it emits a tool call), but Think's built-in
*tools* write to the *agent's own* SQLite. The truth here lives in a **different
DO** (`AppHost`) behind a build-gate, so those tools are turned off and replaced
with custom tools that route through `AppHost` RPC (invariant #5). The
context-management features are the opposite case: they operate purely on the
assistant's *own* transcript (Session/DO SQLite), never touching app files or the
app sandbox, so adopting them costs nothing on the isolation ledger. Note Think's
execute tool is still disabled; Code Mode is wired up *directly* so I control
exactly which tools reach its sandbox (see below).

### Workers platform: modern stack (used)

**Used:** module `fetch` handler, `WorkerEntrypoint` + Workers RPC (the whole
capability broker: `CapabilityBroker`, `ScopedStore`, `ScopedSql`,
`ScopedFilesystem`, `ScopedBlobStore`, `ScopedFetcher`, `ScopedSecrets`,
`ScopedEmail`, `ScopedRoom`, `ScopedScheduler`, `DynamicWorkerTail`), Static
Assets with `run_worker_first`, SQLite-backed DOs (`AppHost`, `CodeAssistant`,
and the three app-runtime DOs `AppData`/`AppSql`/`AppScheduler`), Workers AI
(`AI` binding), **R2** (`BLOBS` bucket, backing the `requestBlobStore`
capability for large binaries), **Cloudflare Email Service** (`send_email` /
`EMAIL` binding, backing the mediated `requestEmail` capability), WebSockets,
**Workers Logs** (`observability`, now `head_sampling_rate: 1`), `nodejs_compat`.

**Unused:** KV, D1, Queues, Workflows, Vectorize, Browser Rendering, cron
triggers. (KV's role is filled by DO SQLite; D1/SQL by the per-room `AppSql` DO.)

**Why:** `WorkerEntrypoint` RPC is the capability-security mechanism: how an
untrusted app gets scoped powers without touching a real binding (invariant #2).
Every app-facing resource is minted by the broker as a scoped stub, so the app
holds no real binding. R2 and the Email Service are the two managed services now
bound, both reached *only* through a mediating stub (`ScopedBlobStore` prefixes
every key by room; `ScopedEmail` enforces sender/recipient policy + a daily cap
host-side). Relational and key/value persistence otherwise lives in DO SQLite by
design, which is why KV and D1 stay unused.

### App runtime data: a dedicated top-level `AppData` DO (used)

**Used:** a top-level Durable Object `AppData` (`src/agent/app-data.ts`), one per
room id, with its **own isolated SQLite**. **Both** kinds of app runtime data
live there: the key/value store (`env.SYSTEM.requestStore`) *and* the filesystem
(`env.SYSTEM.requestFilesystem`, backed by dofs). The `ScopedStore` /
`ScopedFilesystem` capability stubs reach it **directly** via
`env.APP_DATA.get(idFromName(instance))`, so the data path is exactly two hops
(app → scoped stub → `AppData`) and never passes through `AppHost`.

**Not used:** letting *untrusted* app code define the DO class directly. The class
is **trusted framework code**; the untrusted app still reaches it only through the
broker, which validates/quota-checks/path-sanitises every call.

**Why:** Code and runtime data have opposite lifecycles. A separate DO gives
runtime data its own isolated SQLite (blast-radius isolation: a chatty app can't
bloat version history), its own input gate (app writes don't serialize behind code
ops or the realtime coordinator), and platform-enforced isolation. **Host-side
mediation is preserved**: the broker's scoped stubs keep *policy*; the DO adds
*isolation*. Only the realtime coordinator's own state (the `__room__` scope) and
the trusted egress allowlist (the `__egress__` scope) remain in `AppHost`'s SQLite,
since they're framework state, not app data.

#### History: first a Facet, then a top-level DO (limitation #3)

This data first lived in a **Durable Object *Facet***, `AppStorageFacet`, a child
DO reached via `AppHost`'s `this.ctx.facets.get(...)`. I reached for facets
because they are *the* idiomatic way to give a DO a second, isolated SQLite: a
facet runs beneath a parent DO with its own storage and input gate, and the
platform enforces that neither can read the other's database. That got me the
isolation I wanted (app data off `AppHost`'s code store) with a trusted class I
still fronted with the broker.

The catch is **structural**: a facet is only reachable *through its parent*. There
is no way to address a facet by name from outside; you must call the parent DO,
which then calls `ctx.facets.get`. So every `store.get` / `fs.read` was **three
hops**: `app → ScopedStore → AppHost → AppStorageFacet`. That reintroduced exactly
the coupling the facet was meant to remove: `AppHost` (the single per-room code +
realtime DO) sat on the hot path of *every* storage call, so storage traffic
contended with code reads and the realtime coordinator on `AppHost`'s single
input gate. This is limitation **#3** ("single-DO funneling + 3-hop storage").

Promoting the same logic to a **top-level `AppData` DO** keeps every benefit the
facet gave me (isolated SQLite, own input gate, platform isolation, broker-kept
policy) while removing the forced middle hop: a top-level DO *can* be addressed by
name, so `ScopedStore`/`ScopedFilesystem` call it directly (**two hops**) and
`AppHost` leaves the storage path entirely. The class body is essentially
unchanged: it moved from `src/agent/facet/entry.ts` (bundled to a string for the
Worker Loader) to `src/agent/app-data.ts` (a normally-bundled DO), so I also
dropped the `build:facet` esbuild step and the loader indirection.

#### Why NOT a facet: the explicit decision rule

A facet and a top-level DO give the **same isolation** (own SQLite, own input
gate, platform-enforced mutual isolation). They differ on **one axis only:
addressability**. That single difference is the whole decision:

- A **facet has no name.** It is reachable *only* through its parent
  (`parent.ctx.facets.get(...)`). Any external caller must therefore go
  **through the parent**.
- A **top-level DO has a name.** Any binding holder can reach it directly with
  `NS.get(idFromName(...))` / `NS.getByName(...)`.

So the rule I now apply to every "second isolated store" is:

> **Who calls it?**
> • Only the parent, and the store is conceptually part of the parent → **facet**
>   (parent-private sub-store; the parent hop is free because the parent was
>   going to be on the path anyway).
> • Anyone *other* than the parent, especially something on a hot path that must
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
capability stub that must NOT route through AppHost, which rules out a facet by
construction. `CodeAssistant` is separate for an orthogonal reason (it `extends
Think`, single-inheritance vs AppHost's `extends Agent`, and is routed to directly
by name over its own WS route; a facet couldn't be routed to independently).

The general lesson: **facets are the right tool ONLY when the second store is
genuinely subordinate to one parent and only that parent needs it; the moment a
different caller needs it directly, use a named top-level DO so the parent never
becomes a funnel.**

**Possible future simplification (not yet adopted):** enable `enable_ctx_exports`
and reach `AppData`/`AppSql`/`AppScheduler` via `ctx.exports` loopback bindings
instead of the explicit `APP_DATA`/`APP_SQL`/`APP_SCHEDULER` bindings: fewer
declared bindings, same 2-hop direct addressing. I already use the sibling
mechanism (`import { exports } from "cloudflare:workers"` in `runner.ts` /
`broker.ts`) to mint the `WorkerEntrypoint` capability stubs, so extending it to
the DO side is a small, natural step.

### `@cloudflare/dofs` (Workspace): partial (vendored, fs-layer only)

**Used:** `Database` + `initializeSchema` + `WorkspaceFilesystem` from a
**vendored** `@cloudflare/dofs`: the SQLite virtual filesystem powering the
`notes` app's filesystem capability. It runs **inside the `AppData` DO**
(`src/agent/app-data.ts`), tree-shaken to only the filesystem layer by the normal
worker bundle (it needs `nodejs_compat`, which the worker already enables). It does
not execute in the host worker's fetch isolate.

**Unused:** the full `@cloudflare/workspace` package, Container/`wsd` FUSE backend,
capnweb sync protocol, git/blob-cache machinery, all **stripped** from the
vendored build.

**Why:** I needed *only* a DO-SQLite filesystem primitive. It was valuable
enough to vendor and pin (`file:./vendor/dofs`). dofs is orthogonal to where the
storage lives: it is a *data-shape* primitive (turns SQLite into a filesystem),
so it composed cleanly on the facet's isolated storage and composes just as
cleanly now on the `AppData` DO's storage.

### Sandbox SDK (`@cloudflare/sandbox`): not used

**Why:** I sandbox untrusted code with Dynamic Workers instead. The hosted apps
are **JS/TS Workers, not Linux processes**: no `pip`, `npm`, shell, or container
needed. Dynamic Workers give faster cold starts, cheaper tier, and finer
per-request isolation. Sandbox only wins for a full Linux userland.

### Codemode (`@cloudflare/codemode`): used directly (the `code_mode` tool)

**Used:** `createCodeTool` + `aiTools` from `@cloudflare/codemode/ai` and
`DynamicWorkerExecutor` from `@cloudflare/codemode`, wired in
`CodeAssistant.getTools()` as a `code_mode` tool. It lets the model write ONE async
orchestration script over the read/edit tools: fewer round-trips for mechanical
multi-step edits (e.g. "insert a log line at the top of every function"). The
script runs in its **own** Dynamic Worker (`DynamicWorkerExecutor({ loader:
this.env.LOADER })`), and now that codemode is a real dependency it's pinned
explicitly in `package.json` (`^0.4.3`) rather than floating as a transitive dep.

**Not used:** Think's *execute tool* (which is codemode coupled to Think's
workspace); I import codemode **directly** instead, and I do NOT export
codemode's `./tools/execute` (Think 0.13 doesn't ship it anyway).

**Why the direct wiring preserves the invariants:** the risk to guard against is
codemode running code *bypassing* `setFiles` and the build-gate. Wiring it
directly is exactly what prevents that. The executor is constructed with
`{ loader }` **only**: `globalOutbound` stays at its default `null` (no egress) and
**no `env`/bindings** are passed. The script reaches the host solely via Workers
RPC to a *curated* set of tools (`CODE_MODE_SANDBOX_TOOLS`: read/edit only, NOT
`rollback`/`reset_app`, NOT `code_mode` itself), whose `execute` bodies still run
host-side and still write through `AppHost.setFiles`. So Code Mode adds a *second
orchestration sandbox* for the assistant; the untrusted-app sandbox and the single
gated write path are unchanged (invariants #5, #11). Feeding Think's
workspace/state tools into `createCodeTool` would have handed the sandbox a
filesystem it must not have, which is precisely why I bypass Think's helper and
control the tool list myself.

---

## 3. Workaround verdict: what the platform has since changed

This project accreted a few workarounds to fit the "code as gated data" model
onto the SDKs as they were at the time. The platform has moved since, so it is
worth recording plainly which of those workarounds the SDKs have since eased and
which remain architecturally required. The point is to stop other teams
over-generalising from "the platform shipped X, so I can drop my workaround":
sometimes X solves an adjacent problem, not mine.

| Workaround | Still necessary? | Why |
|---|---|---|
| **Facet → top-level `AppData` DO** | **Yes, keep** | Facets are still parent-mediated: the current [DO Facets docs](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/) create a facet via `this.ctx.facets.get()` *inside the supervisor*, and the facet's SQLite is stored as part of the parent DO. So reaching one still funnels through the parent (`app → ScopedStore → AppHost → facet`), exactly the hot-path contention I removed (limitation #3). `ctx.exports` addresses *top-level DOs* by name, not facets, so it only lets me drop the explicit `APP_DATA`/`APP_SQL`/`APP_SCHEDULER` bindings; the DOs stay top-level. The migration was the correct fix, not wasted effort. |
| **Vendoring `@cloudflare/dofs`** | **Mostly** | It is now a published package in `cloudflare/workspace`, but that repo is PREVIEW-only / not production. Pinning a vendored copy stays defensible; revisit switching to the published dependency at GA. |
| **Disabling Think's built-in tools + hand-rolled bridge to `AppHost`** | **Partly reducible** | Think now supports custom Workspace backends (`override workspace = new Workspace({ sql, r2 })`, `createWorkspaceTools()`), so "put the bytes elsewhere" no longer needs a full hand-roll. But routing writes through an *external* build-gate (`setFiles` in another DO) still is not first-class, so I still disable the defaults and bridge over RPC. |
| **Codemode direct-wiring (not via Think's `execute`)** | **Yes, and never really a workaround** | `@cloudflare/codemode`'s core entry is standalone by design (no `ai`/`zod` peer dep). Importing it directly to control the sandbox tool list is the intended pattern, not a hack. |

A note on the facet point specifically: an earlier reading treated `ctx.exports`
as "facets are now addressable by name." They are not the same mechanism:
`ctx.exports` names top-level DO classes, while facets remain reachable only
through their supervisor. The top-level-DO decision therefore stands. See §"App
runtime data" for the full facet history and the "Why NOT a facet" decision rule.

---

## 4. Feedback for the SDK teams

These are suggestions, not asks, just notes from building one fairly demanding
app on these SDKs, with where each stands today. "Status" is where the SDK is
now; see §3 for my own verdict on the workarounds these prompted.

1. **A production-supported standalone `dofs`.** I only wanted the DO-SQLite
   filesystem, so I vendored it; it'd be nice to just depend on it.
   *Status:* `@cloudflare/dofs` is now published in `cloudflare/workspace` and
   `Workspace` can run backend-less, but it's preview-only, so I'm still pinning
   my vendored copy.
2. **Keep Think's execution deps optional.** When Think runs as a sub-agent with
   custom tools, `@cloudflare/shell` + just-bash are pure bundle cost for me.
   *Status:* mostly there. execute/workspace/fetch/extensions are opt-in subpaths
   and codemode's core has no `ai`/`zod` peer dep. The default `bash` tool still
   pulls just-bash unless I set `workspaceBash = false` (I do).
3. **A bring-your-own-write-path hook in Think.** Think assumes the agent owns its
   filesystem, but my source of truth lives behind a build-gate in another DO, so
   I disable the built-in tools and bridge over RPC.
   *Status:* you can now swap the storage backend (`override workspace = new
   Workspace(...)`), which covers "store the bytes elsewhere." What I'd still love
   is a way to route writes through an arbitrary async gate (validation, versioning)
   rather than a Workspace-shaped store.
4. **A short "facet vs top-level DO" note in the docs.** I reached for a facet as
   a second isolated SQLite, but since it's only reachable through its parent it
   turned the parent into a hot-path funnel (#3), and I migrated to a top-level DO.
   *Status:* `ctx.exports` now addresses top-level DOs by name (handy: it lets me
   drop binding boilerplate), but per the current
   [DO Facets docs](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
   facets are still parent-mediated, so it's not the same thing. A "who calls it?"
   decision note would have saved me the round-trip (I wrote my own in §3).
5. **Graduating Dynamic Workers out of preview.** My whole premise is now the
   headline Dynamic Workers use case ("AI Code Mode" / "vibe-coded apps"), which is
   great to see; the main thing gating real use is the preview-grade status (#11).
   The new DO-Facets-for-loaded-code feature also looks like a clean way to give an
   untrusted app its own store; a worked example would help.
6. **A higher-level codemode recipe.** I use only `createCodeTool`, but Connectors,
   Snippets, and runtime approvals look directly useful (an `OpenApiConnector` for
   my mediated egress; Snippets to persist the assistant's proven edits). A
   "codemode as a mediated orchestration layer" example would help me adopt them.
