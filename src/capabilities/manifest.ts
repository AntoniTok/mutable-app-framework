/**
 * The capability manifest — the SINGLE source of truth for what `env.SYSTEM`
 * offers apps.
 *
 * WHY THIS EXISTS: a capability only really exists for users when THREE things
 * agree — the runtime stub (code), the app contract (`templates/types.ts`), and
 * the AI assistant's system prompt (`assistant/code-assistant.ts`). Since most
 * apps are written BY the assistant, a capability the prompt doesn't mention is
 * invisible. Historically those lived in three hand-maintained places and drifted.
 *
 * Now they're described ONCE here. The assistant prompt and the human-facing
 * contract both render from this list, and `declares` is validated against it.
 * Adding a capability = add an entry here + its `scoped-*.ts` stub + a `broker`
 * method; the prompt and docs update automatically.
 */

/** Stable capability ids (the `AppTemplate.declares` vocabulary). */
export type CapabilityId =
  | "store"
  | "sql"
  | "fs"
  | "blob"
  | "fetch"
  | "secrets"
  | "email"
  | "room"
  | "scheduler";

export interface CapabilitySpec {
  /** Stable id used in `AppTemplate.declares` and per-app config keys. */
  id: CapabilityId;
  /** Human label for the Resources/UI. */
  label: string;
  /** One-line summary (Resources panel, docs headings). */
  summary: string;
  /**
   * The contract snippet injected into the assistant's system prompt — i.e. how
   * the AI is told to USE this capability. Kept terse and imperative; this is
   * prompt real estate. One capability = one bullet.
   */
  prompt: string;
  /**
   * Available TODAY. `false` = reserved/coming-soon: documented for humans but
   * NOT offered to the AI and NOT a valid `declares` entry yet.
   */
  available: boolean;
  /** Has per-app configuration surfaced in the Resources panel / an /api route. */
  configurable: boolean;
}

/**
 * The catalog. Order here is the order the AI sees them in the prompt, so lead
 * with the everyday ones (store, fs) and end with the escape hatches (fetch).
 */
export const CAPABILITIES: CapabilitySpec[] = [
  {
    id: "store",
    label: "Key/value store",
    summary: "Flat per-app string store with atomic incr/cas and JSON helpers.",
    available: true,
    configurable: true, // storeMaxValueBytes / storeMaxTotalBytes (see config/limits)
    prompt:
      'Key/value: const s = await env.SYSTEM.requestStore("ns"); s.put/get/list/delete (string values). For counters or any read-modify-write, use the ATOMIC ops s.incr(key, delta) (returns the new number) and s.cas(key, expected, next) — a get()+put() pair races under concurrent requests and loses updates, so never hand-roll a counter that way. Convenience: s.putJSON(key, obj) / s.getJSON(key).'
  },
  {
    id: "sql",
    label: "SQL database",
    summary: "Private relational SQLite database: your own tables + arbitrary queries.",
    available: true,
    configurable: true, // sqlMaxRows / sqlMaxDbBytes (see config/limits)
    prompt:
      'SQL (relational database — use this over the key/value store whenever data is tabular, related, filtered, sorted, or aggregated, e.g. leaderboards, todo lists, chat logs): const db = await env.SYSTEM.requestSql(); create tables once with await db.exec("CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, text TEXT, done INTEGER DEFAULT 0)"); read with await db.query("SELECT * FROM todos WHERE done = ?", 0) (returns rows[]) or await db.first("SELECT * FROM todos WHERE id = ?", id); write with await db.run("INSERT INTO todos (text) VALUES (?)", text) (returns {rowsWritten, lastRowId}). ALWAYS use ? placeholders with params — NEVER concatenate user input into SQL. Booleans are stored as 0/1. Queries are capped (sqlMaxRows) so paginate with LIMIT; the DB has a size cap (sqlMaxDbBytes).'
  },
  {
    id: "fs",
    label: "Filesystem",
    summary: "Per-app virtual filesystem (folders, search) for small structured data.",
    available: true,
    configurable: false,
    prompt:
      'Filesystem (small structured data, <=256KiB per file): const fs = await env.SYSTEM.requestFilesystem("ns"); fs.readFile/writeFile/readdir/mkdir/rm/stat/grep/find (relative paths, no leading slash or "..").'
  },
  {
    id: "blob",
    label: "Blob store",
    summary: "R2-backed store for large binaries (images, audio, exports).",
    available: true,
    configurable: false,
    prompt:
      'Large binary objects (images, audio, exports too big for the 256KiB fs cap): const blobs = await env.SYSTEM.requestBlobStore("ns"); blobs.put(key, bytesOrString)/get(key)->ArrayBuffer|null/delete(key)/list()->string[].'
  },
  {
    id: "fetch",
    label: "Mediated egress",
    summary: "Outbound fetch, allowlist-gated (the app sandbox has no direct network).",
    available: true,
    configurable: true, // egress allowlist + fetch timeout/size/redirect caps
    prompt:
      "NO direct network access. The ONLY way out is mediated fetch, and ONLY to hosts on this app's allowlist (managed by the user via the room's egress settings, NOT by you or the app): const net = await env.SYSTEM.requestFetch(); const res = await net.send(url, { method, headers, body }); res = { status, statusText, headers, body(ArrayBuffer) }. A host that isn't allowlisted throws (redirects are re-checked per hop) — if the user wants a new API, tell them to add its host in egress settings."
  },
  {
    id: "secrets",
    label: "Secrets",
    summary: "API keys/credentials the user sets; used without being read (unless flagged readable).",
    available: true,
    configurable: true, // managed via the room's secret settings / /api/secrets
    prompt:
      "Secrets (API keys/credentials): the USER adds these in the room's secret settings — neither you nor the app can read a value unless it is explicitly flagged readable. To call an authenticated API, INJECT a secret into a header without reading it: await net.send(url, { secretHeaders: { Authorization: { secret: \"MY_KEY\", prefix: \"Bearer \" } } }). To check availability: const sec = await env.SYSTEM.requestSecrets(); await sec.has(\"MY_KEY\") / await sec.list(). Reading a raw value (await sec.get(\"MY_KEY\")) works ONLY for secrets the user marked readable (e.g. for signing); otherwise it throws. If a needed secret is missing, tell the user to add it in the room's secret settings — never hardcode a key."
  },
  {
    id: "email",
    label: "Email",
    summary: "Send transactional email, mediated by the room's sender/recipient policy.",
    available: true,
    configurable: true, // managed via the room's email settings / /api/email
    prompt:
      "Email (transactional): const mail = await env.SYSTEM.requestEmail(); await mail.send({ to, subject, html, text, cc?, bcc?, replyTo?, from? }). The USER configures allowed senders/recipients + a daily cap in the room's email settings — you CANNOT pick an arbitrary From (omit `from` to use the default) or exceed the cap; a disallowed sender/recipient or an unconfigured mailbox throws. Always include a plain-text `text` alongside `html`. For transactional mail only (confirmations, alerts), not bulk/marketing."
  },
  {
    id: "scheduler",
    label: "Scheduler",
    summary: "Run code later: one-shot delays, absolute times, or recurring intervals.",
    available: true,
    configurable: true, // maxScheduledTasks (see config/limits)
    prompt:
      "Scheduler (run code LATER): const s = await env.SYSTEM.requestScheduler(); await s.after(seconds, 'taskName', payload?) runs once after a delay; await s.at(unixMs, 'taskName', payload?) at an absolute time; await s.every(seconds, 'taskName', payload?) recurs (min 1s); await s.cancel(id); await s.list(). Each returns {id, runAt}. To handle them, export an async onSchedule(env, ctx) — ctx = {task, payload} — which runs in the normal sandbox with env.SYSTEM, so a task can persist (requestStore), fetch, email, or push to clients (requestRoom.broadcast). Pending tasks are capped (maxScheduledTasks). Use for reminders, timeouts, polling, and timed realtime updates (pair with requestRoom)."
  },
  {
    id: "room",
    label: "App-driven realtime",
    summary: "Push to connected clients from your own code (broadcast/send/presence).",
    available: true,
    configurable: false,
    prompt:
      "App-driven realtime (PUSH to connected clients from your OWN code — an HTTP handler, webhook, or scheduled task): const room = await env.SYSTEM.requestRoom(); await room.broadcast(msg) sends {type:'app',data:msg} to every connected client; await room.send(seat, msg) targets one seat; await room.presence() → {seats,players,count}. This is the ESCAPE HATCH — the DEFAULT for multiplayer is still the pure applyAction reducer (the framework owns sockets/seats/state). Use requestRoom when the UPDATE originates outside a WebSocket action (e.g. POST /notify → room.broadcast). Keep your own state in requestStore; the client page connects a WebSocket to /agents/app-host/<room>?token=<id> and handles the {type:'app'} frame."
  }
];

/**
 * All KNOWN capability ids — the valid `declares` vocabulary. Includes reserved
 * ids (e.g. "room", which templates already use to mark realtime participation)
 * even before their broker hook ships, so declaring one is never "unknown".
 */
export const KNOWN_CAPABILITY_IDS: ReadonlySet<CapabilityId> = new Set(
  CAPABILITIES.map((c) => c.id)
);

/** Look up one capability spec by id. */
export function getCapability(id: string): CapabilitySpec | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/**
 * Render the available capabilities as system-prompt bullet lines (the block the
 * assistant reads under "persist via env.SYSTEM"). Single source, so the prompt
 * can never fall out of sync with what the broker actually grants.
 */
export function renderCapabilityContract(): string {
  return CAPABILITIES.filter((c) => c.available && c.prompt)
    .map((c) => `- ${c.prompt}`)
    .join("\n");
}

/**
 * Filter/validate a template's declared capabilities against the catalog,
 * dropping any that aren't available (with the offenders returned for logging).
 */
export function validateDeclares(declares: string[]): {
  valid: CapabilityId[];
  unknown: string[];
} {
  const valid: CapabilityId[] = [];
  const unknown: string[] = [];
  for (const d of declares) {
    if (KNOWN_CAPABILITY_IDS.has(d as CapabilityId)) valid.push(d as CapabilityId);
    else unknown.push(d);
  }
  return { valid, unknown };
}
