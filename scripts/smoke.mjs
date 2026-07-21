// Runtime smoke test for the mutable-app-framework.
//
// App selection is per-room at runtime, so this script CREATES a FRESH room seeded
// with the app under test (POST /api/create), then auto-detects the seeded app
// (via GET /api/state → templateId) and runs the matching checks. A fresh room
// with no template seeds the default (blackjack), which has no suite — so pass the
// app you want to test. No dependencies — Node 22+ provides global fetch/WebSocket.
//
// Usage (dev server must be running):
//   npm run dev                       # in one terminal
//   npm run smoke -- counter          # in another (counter | tictactoe | poker)
//   npm run smoke -- poker http://localhost:8788
//   SMOKE_TEMPLATE=tictactoe npm run smoke
//
// To verify all three, run it three times with counter | tictactoe | poker.

// Args in any order: one that looks like a URL is the base, the other the template.
const ARGS = process.argv.slice(2);
const BASE = (ARGS.find((a) => /^https?:\/\//.test(a)) || process.env.SMOKE_URL || "http://localhost:8787").replace(/\/$/, "");
const TEMPLATE = ARGS.find((a) => !/^https?:\/\//.test(a)) || process.env.SMOKE_TEMPLATE || "";
const ROOM = `smoke_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  \u2713 ${label}`); }
  else { fail++; console.log(`  \u2717 ${label}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(path) {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}room=${encodeURIComponent(ROOM)}`;
  const res = await fetch(url);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json, headers: res.headers };
}

async function apiPost(path, body) {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}room=${encodeURIComponent(ROOM)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}

function wsUrl() {
  const proto = BASE.startsWith("https") ? "wss" : "ws";
  const host = BASE.replace(/^https?:\/\//, "");
  return (token) =>
    `${proto}://${host}/agents/app-host/${encodeURIComponent(ROOM)}?token=${encodeURIComponent(token)}`;
}

/** A tiny WebSocket client that records `welcome`/`state` frames and lets tests await them. */
class Client {
  constructor(token) {
    this.token = token;
    this.seat = undefined;      // set on welcome
    this.states = [];           // every {type:"state"} payload received
    this._waiters = [];         // { pred, resolve, reject, timer }
    this._welcome = deferred();
    const ws = new WebSocket(wsUrl()(token));
    this.ws = ws;
    this._open = deferred();
    ws.addEventListener("open", () => this._open.resolve());
    ws.addEventListener("error", (e) => {
      this._open.reject(new Error("ws error: " + (e?.message || "unknown")));
    });
    ws.addEventListener("message", (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (m.type === "welcome") { this.seat = m.seat ?? null; this._welcome.resolve(m); }
      else if (m.type === "state") {
        this.states.push(m);
        for (const w of this._waiters.slice()) {
          if (w.pred(m)) { clearTimeout(w.timer); this._waiters.splice(this._waiters.indexOf(w), 1); w.resolve(m); }
        }
      }
    });
  }
  ready() { return Promise.all([this._open.promise, this._welcome.promise]); }
  last() { return this.states[this.states.length - 1]; }
  /** Resolve when a state frame arriving AFTER now matches `pred` (or timeout). */
  waitState(pred = () => true, ms = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w.resolve !== resolve);
        reject(new Error("timeout waiting for state"));
      }, ms);
      this._waiters.push({ pred, resolve, reject, timer });
    });
  }
  send(action) { this.ws.send(JSON.stringify({ type: "action", action })); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── per-app suites ───────────────────────────────────────────────────────────

async function testCounter() {
  const home = await apiGet("/preview/");
  ok(home.status === 200 && /text\/html/.test(home.headers.get("content-type") || ""), "GET /preview/ returns HTML");
  ok(/id="count"/.test(home.text) && /\+1/.test(home.text), "page shows the counter UI");

  const inc1 = await apiGet("/preview/inc");
  const inc2 = await apiGet("/preview/inc");
  ok(inc1.json?.count === 1 && inc2.json?.count === 2, "inc increments and persists (1 then 2)");
  const dec = await apiGet("/preview/dec");
  ok(dec.json?.count === 1, "dec decrements (back to 1)");
  const reset = await apiGet("/preview/reset");
  ok(reset.json?.count === 0, "reset sets to 0");
  const count = await apiGet("/preview/count");
  ok(count.json?.count === 0, "count reflects persisted value (0)");
}

async function testTictactoe() {
  const x = new Client("tok-x");
  const o = new Client("tok-o");
  await x.ready();
  await o.ready();
  ok(x.seat === "X" && o.seat === "O", `two clients seated X/O (got ${x.seat}/${o.seat})`);

  const spec = new Client("tok-spec");
  await spec.ready();
  ok(spec.seat === null, "third client is a spectator (seat null)");

  // Play a winning line for X: X:0, O:3, X:1, O:4, X:2 → X wins the top row.
  const moves = [[x, 0], [o, 3], [x, 1], [o, 4], [x, 2]];
  for (const [client, cell] of moves) {
    const seen = x.waitState((m) => m.state.board[cell] === client.seat);
    client.send({ type: "move", cell });
    await seen;
  }
  await sleep(150);
  ok(x.last().state.winner === "X", "X wins after the top row");
  ok(JSON.stringify(x.last().state) === JSON.stringify(o.last().state), "both seated players receive IDENTICAL state (symmetric, no view)");

  // Turn enforcement: O playing on X's turn is rejected (state unchanged).
  const before = JSON.stringify(x.last().state);
  o.send({ type: "move", cell: 6 });
  await sleep(300);
  ok(JSON.stringify(x.last().state) === before, "illegal move (already won / wrong turn) is rejected");

  // Rematch resets the board.
  const reset = x.waitState((m) => m.state.winner === null && m.state.board.every((c) => c === null));
  x.send({ type: "rematch" });
  await reset;
  ok(true, "rematch resets to an empty board");

  x.close(); o.close(); spec.close();
}

async function testPoker() {
  const a = new Client("tok-a");
  const b = new Client("tok-b");
  await a.ready();
  await b.ready();
  ok(/^P[1-6]$/.test(a.seat || "") && /^P[1-6]$/.test(b.seat || "") && a.seat !== b.seat,
    `two clients get distinct poker seats (got ${a.seat}/${b.seat})`);

  // Sit both players, then deal a hand.
  a.send({ type: "sit" });
  b.send({ type: "sit" });
  await sleep(300);
  const dealtA = a.waitState((m) => seatHole(m, a.seat).some((c) => c));   // own cards revealed
  a.send({ type: "start" });
  await dealtA;
  await sleep(200);

  const av = a.last().state;
  const bv = b.last().state;
  ok(JSON.stringify(av) !== JSON.stringify(bv), "seated players receive DIFFERENT state (per-player view active)");
  ok(seatHole(a.last(), a.seat).some((c) => c), "player A sees its OWN hole cards");
  ok(seatHole(b.last(), a.seat).every((c) => !c), "player B does NOT see A's hole cards (hidden)");

  a.close(); b.close();
}

/** Extract a seat's hole cards from a projected poker state frame (schema-tolerant). */
function seatHole(frame, seat) {
  const p = frame?.state?.players?.[seat];
  return Array.isArray(p?.hole) ? p.hole : [];
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`smoke: ${BASE}  room=${ROOM}  template=${TEMPLATE || "(default)"}`);
  let state;
  try {
    // Seed the fresh room with the requested app (idempotent; no-op if unknown).
    await apiPost("/api/create", TEMPLATE ? { template: TEMPLATE } : {});
    state = await apiGet("/api/state");
  } catch (e) {
    console.error(`\nCannot reach ${BASE} — is \`npm run dev\` running?\n${e.message}`);
    process.exit(2);
  }
  const app = state.json?.templateId;
  console.log(`hosted app: ${app}\n`);

  const suites = { counter: testCounter, tictactoe: testTictactoe, poker: testPoker };
  const suite = suites[app];
  if (!suite) {
    console.error(
      `No smoke suite for templateId="${app}". Pass an app to test: ` +
        `npm run smoke -- <${Object.keys(suites).join(" | ")}>.`
    );
    process.exit(2);
  }

  try {
    await suite();
  } catch (e) {
    fail++;
    console.log(`  \u2717 suite threw: ${e.message}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
