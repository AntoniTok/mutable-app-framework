# Mutable App Framework — Architecture & Cloudflare SDK Usage

This document explains our central design idea — **the program lives as
data** — and then walks each Cloudflare technology, listing what we use,
what we don't, and why. It reflects the codebase *after* introducing Durable
Object Facets and Dynamic Worker Tail observability, and the later additions of
**Code Mode** (a second Dynamic Worker sandbox for the assistant's orchestration
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

### Two kinds of truth (why the facet exists)

Code and app *runtime data* have opposite lifecycles:

| | Code (`versions`/`files`) | App runtime data |
|---|---|---|
| Nature | Versioned artifact | Live mutable state |
| Written by | The build-gate (`setFiles`) | The running app, per request |
| Rolled back? | Yes | No — it's "now" |
| Owner | `AppHost` supervisor SQLite | **A facet's isolated SQLite** |

Because they differ, they now live in different stores: **code stays in
`AppHost`; app runtime data moved into a Durable Object Facet** (see §Facets).

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
**Durable Object Facets** (all app runtime data — see below), **Tail Workers**
(per-run observability — see below), and a **second sandbox for Code Mode**:
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

### Durable Object Facets — used (ALL app runtime data)

**Used:** `this.ctx.facets.get(...)` in `AppHost` runs a trusted `AppStorageFacet`
(loaded via the Worker Loader, `worker.getDurableObjectClass(...)`) with its
**own isolated SQLite**. **Both** kinds of app runtime data live there: the
key/value store (`env.SYSTEM.requestStore`) *and* the filesystem
(`env.SYSTEM.requestFilesystem`, backed by dofs). See
`src/agent/facet/entry.ts` (the facet class), `src/agent/app-storage-facet.ts`
(the surface), and `AppHost.#appData()` (the forwarding layer).

**Not used:** letting *untrusted* app code define the facet class directly (the
docs' "give dynamic code storage" pattern). Here the facet class is **trusted
framework code**; the untrusted app still reaches it only through the broker.

**Why:** Code and runtime data have opposite lifecycles. A facet gives runtime
data its own isolated SQLite (blast-radius isolation — a chatty app can't bloat
version history), its own input gate (app writes no longer serialize behind code
ops and the realtime coordinator), and platform-enforced isolation. Crucially,
**host-side mediation is preserved**: the broker still validates, quota-checks,
and path-sanitises every call before `AppHost` forwards it into the facet — facets
add *isolation*, the broker keeps *policy*. Only the realtime coordinator's own
state remains in `AppHost`'s SQLite (the `__room__` scope), since it's framework
state, not app data.

### `@cloudflare/dofs` (Workspace) — partial: vendored, fs-layer only, runs in the facet

**Used:** `Database` + `initializeSchema` + `WorkspaceFilesystem` from a
**vendored** `@cloudflare/dofs` — the SQLite virtual filesystem powering the
`notes` app's filesystem capability. It now runs **inside the facet**
(`src/agent/facet/entry.ts`), bundled and tree-shaken to only the filesystem
layer by `scripts/build-facet.mjs`. It no longer executes in the host isolate.

**Unused:** the full `@cloudflare/workspace` package, Container/`wsd` FUSE backend,
capnweb sync protocol, git/blob-cache machinery — all **stripped** from the
vendored build (and further dropped by tree-shaking the facet bundle).

**Why:** We needed *only* a DO-SQLite filesystem primitive. It was valuable
enough to vendor and pin (`file:./vendor/dofs`). dofs is orthogonal to facets: it
is a *data-shape* primitive (turns SQLite into a filesystem), while facets are a
*storage-location* primitive — so it composes cleanly, running on the facet's own
isolated storage.

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
3. **Bundle weight is now dominated by Think.** Moving dofs into the facet trims
   the host worker only modestly (~30 KB): the facet source still ships *embedded
   as a string* in the host bundle (it must, to hand to the Worker Loader), but
   dofs no longer executes in the host isolate. The remaining ~5 MB is Think's
   transitive deps (`ai` v6, `@cloudflare/shell`, just-bash) plus codemode — but
   codemode is no longer *dead* weight, since the `code_mode` tool now uses it
   directly. None of these can be dropped without removing the assistant or Code
   Mode.

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
4. **Facets' value scales with app-data weight + isolation needs.** For
   prototype-scale apps the broker-over-shared-SQLite approach is often enough;
   facets pay off as data grows, write throughput contends with realtime, or the
   threat model demands platform-enforced isolation over trusted-code correctness.
