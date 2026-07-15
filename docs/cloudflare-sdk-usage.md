# Mutable App Framework — Architecture & Cloudflare SDK Usage

This document explains the project's central design idea — **the program lives as
data** — and then walks each Cloudflare technology, listing what the project uses,
what it doesn't, and why. It reflects the codebase *after* introducing Durable
Object Facets and Dynamic Worker Tail observability (see
[Recent changes](#recent-changes)).

---

## 1. The core idea: the program lives as data

In a conventional Cloudflare app, **the source of truth for code is the
deployment**. You `wrangler deploy`, and the code baked into the Worker is what
runs. Code is static; only data changes at runtime.

This project **inverts that**:

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

Legend: ✅ used · ⚠️ partial/reserved · ❌ not used

### Agents SDK (`agents`) — ✅ core backbone

**Used:** `Agent` base class (`AppHost`), `routeAgentRequest`, `getAgentByName`,
agent state (as a pointer), WebSocket lifecycle
(`onStart`/`onConnect`/`onMessage`/`onClose`), `broadcast`/`getConnections`,
`this.sql`.

**Unused:** scheduling/cron (realtime is event-driven), MCP (tools are local),
React hooks/`useAgent` (hand-rolled vanilla-JS `cf_agent_chat_*` client to avoid
React bundle weight), `agent-tools` sub-agent dispatch (assistant→AppHost is plain
RPC), `hono-agents` (plain `fetch`).

**Why:** Ideal substrate — per-room DO isolation, built-in WebSockets, SQLite in
one place. The team leans on the primitives that support "code as gated data" and
skips convenience layers that add bundle weight or don't fit a local-tool,
event-driven model.

### Dynamic Workers (`worker_loaders` + `@cloudflare/worker-bundler`) — ✅ the sandbox

**Used:** `env.LOADER.get()`, `createWorker()`, custom `SYSTEM` capability-binding
injection, `globalOutbound: null` (no network egress), content-hash warm caching,
**Durable Object Facets** (all app runtime data — see below), **Tail Workers**
(per-run observability — see below).

**Unused:** custom resource limits (`limits.cpuMs`/`subRequests`) on the dynamic
run.

**Why:** This *is* how untrusted app code runs — isolate-level security,
millisecond cold starts, per-request fan-out. `globalOutbound: null` plus a single
capability binding is the whole security posture (invariants #1, #2).

### `@cloudflare/think` — ✅ used, deliberately trimmed

**Used:** `Think` base (`CodeAssistant`), `getModel`/`getSystemPrompt`,
`getTools()` with AI SDK `tool()`/`ToolSet`, `maxSteps`, `configureSession` +
writable memory context block, Session FTS5 history, `beforeTurn`→`TurnConfig`
tool-gating, the `cf_agent_chat_*` WS protocol.

**Unused (explicitly disabled):** built-in workspace/`bash` tools
(`workspaceBash = false`), code-execution tool (which pulls Codemode), Agent
Skills, scheduled tasks, messengers, extensions, sub-agent dispatch,
context-overflow recovery.

**Why:** They wanted the hard parts — the agentic loop, streaming, persistence,
per-room memory — but Think's built-in tools write to the *agent's own* SQLite.
The truth here lives in a **different DO** (`AppHost`) behind a build-gate, so
those tools are turned off and replaced with custom tools that route through
`AppHost` RPC (invariant #5).

### Workers platform — ✅ modern stack

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

### Durable Object Facets — ✅ used (ALL app runtime data)

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

### `@cloudflare/dofs` (Workspace) — ⚠️ vendored, fs-layer only, runs in the facet

**Used:** `Database` + `initializeSchema` + `WorkspaceFilesystem` from a
**vendored** `@cloudflare/dofs` — the SQLite virtual filesystem powering the
`notes` app's filesystem capability. It now runs **inside the facet**
(`src/agent/facet/entry.ts`), bundled and tree-shaken to only the filesystem
layer by `scripts/build-facet.mjs`. It no longer executes in the host isolate.

**Unused:** the full `@cloudflare/workspace` package, Container/`wsd` FUSE backend,
capnweb sync protocol, git/blob-cache machinery — all **stripped** from the
vendored build (and further dropped by tree-shaking the facet bundle).

**Why:** They needed *only* a DO-SQLite filesystem primitive. It was valuable
enough to vendor and pin (`file:./vendor/dofs`). dofs is orthogonal to facets: it
is a *data-shape* primitive (turns SQLite into a filesystem), while facets are a
*storage-location* primitive — so it composes cleanly, running on the facet's own
isolated storage.

### Sandbox SDK (`@cloudflare/sandbox`) — ❌ unused

**Why:** The project sandboxes untrusted code with Dynamic Workers instead. The
hosted apps are **JS/TS Workers, not Linux processes** — no `pip`, `npm`, shell,
or container needed. Dynamic Workers give faster cold starts, cheaper tier, and
finer per-request isolation. Sandbox only wins for a full Linux userland.

### Codemode (`@cloudflare/codemode`) — ❌ unused (transitive)

**Why:** Not in `package.json`; pulled in only by `@cloudflare/think` /
`@cloudflare/shell`, never imported. Codemode powers Think's execute-tool, which
would run code *bypassing* `setFiles` and the build-gate — a direct violation of
the single gated write path (invariant #5). It ships as dead weight in the Think
bundle.

---

## 3. Suggestions

**For the project:**
1. **Add custom resource limits** (`limits.cpuMs` / `subRequests`) to the dynamic
   run to bound runaway generated code, complementing `globalOutbound: null`.
2. **Consider AI Gateway** in front of the model calls for caching,
   rate-limiting, and cost/latency observability on the agentic loop.
3. **Bundle weight is now dominated by Think.** Moving dofs into the facet trims
   the host worker only modestly (~30 KB): the facet source still ships *embedded
   as a string* in the host bundle (it must, to hand to the Worker Loader), but
   dofs no longer executes in the host isolate. The remaining ~5 MB is Think's
   transitive deps (`ai` v6, codemode, `@cloudflare/shell`, just-bash), which
   can't be dropped without removing the assistant.

**For the SDK teams (feedback):**
1. **Publish `dofs`'s filesystem layer as a supported standalone.** Clearest
   demand signal — users want the DO-SQLite VFS decoupled from
   `wsd`/capnweb/git/container. This project had to vendor it.
2. **Make Think's execution deps (codemode/shell/just-bash) optional/peer.** When
   Think runs as a scoped sub-agent with custom tools, they are pure bundle cost.
3. **Support a "bring-your-own-filesystem" hook in Think.** Its biggest friction:
   it assumes the agent owns its filesystem. Users whose source of truth is
   external/gated (another DO, VCS, a build step) must disable the built-in tools.
4. **Facets' value scales with app-data weight + isolation needs.** For
   prototype-scale apps the broker-over-shared-SQLite approach is often enough;
   facets pay off as data grows, write throughput contends with realtime, or the
   threat model demands platform-enforced isolation over trusted-code correctness.
