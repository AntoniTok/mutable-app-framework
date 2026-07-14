/**
 * The app contract.
 *
 * An "app" is just a set of source files that the framework stores, versions,
 * and runs. Every app must obey the RUNTIME CONTRACT below so that both the
 * runner (which executes it) and the AI author (which writes it) can treat all
 * apps identically.
 *
 * ── RUNTIME CONTRACT (what generated/edited code must look like) ──
 *   - Provide a default export with a `fetch(request, env)` handler,
 *     e.g. `export default { fetch(request, env) { ... } }`.
 *   - Persist data ONLY through the capability broker handed in as `env.SYSTEM`.
 *     Two storage capabilities exist today:
 *
 *       // Flat key/value store — strings in, strings out.
 *       const store = await env.SYSTEM.requestStore("main");
 *       await store.put("count", "1");
 *       const n = await store.get("count");   // string | null
 *
 *       // Filesystem — folders, listing, search. For SMALL structured data
 *       // (notes, config, history), NOT large blobs (files cap at 256 KiB).
 *       const fs = await env.SYSTEM.requestFilesystem("main");
 *       await fs.writeFile("notes/todo.md", "buy milk");  // creates parents
 *       const text = await fs.readFile("notes/todo.md");  // string | null
 *       const entries = await fs.readdir("notes");        // [{name,type}] | null
 *       const meta = await fs.stat("notes/todo.md");      // {type,size,mtime} | null
 *       await fs.mkdir("drafts");
 *       await fs.rm("notes/todo.md");                     // {recursive?:boolean}
 *       const hits = await fs.grep("milk", "notes");      // [{path,line,text}]
 *       const found = await fs.find("", "*.md");          // [{path,type}]
 *
 *     Filesystem paths are namespace-relative (no leading "/", no ".."); missing
 *     files/dirs read back as `null`. Pick ONE capability that fits the data —
 *     don't mirror the same data into both.
 *   - There is NO direct network access (egress is blocked). Reach the outside
 *     world only through capabilities the broker grants.
 *
 * ── REALTIME CONTRACT (optional — for multiplayer apps) ──
 *   An app becomes multiplayer by adding two PURE named exports. It still holds
 *   no sockets and does no I/O: the framework's realtime coordinator (see
 *   src/realtime/) owns the WebSockets, presence and broadcast, and calls these
 *   in the sandbox.
 *
 *     // The starting shared state for a fresh game/room.
 *     export const initialState = { ... };          // or a function
 *
 *     // A PURE reducer: given the current shared state and one player's action,
 *     // return the next shared state. No network, no store, no randomness that
 *     // must persist — just (state, action, ctx) -> nextState.
 *     export function applyAction(state, action, ctx) { ... }
 *
 *   `ctx` is supplied by the trusted core: `{ seat, playerId }`. `seat` is the
 *   opaque player slot the coordinator assigned; the reducer decides what that
 *   seat is allowed to do. Return the state unchanged to reject an illegal
 *   action. Randomness is allowed here (e.g. `Math.random()` to shuffle a deck):
 *   the result is persisted as the next state, so it stays consistent for all.
 *
 *   SEATS (optional). Seat names are declared BY THE APP — the framework core
 *   owns none. Export a `seats` array (or a function returning one) to tell the
 *   coordinator which slots to hand out:
 *
 *     export const seats = ["X", "O"];        // or ["P1","P2",...], etc.
 *
 *   The coordinator assigns each player one of these (bound to a stable browser
 *   token) and passes it as `ctx.seat`. No `seats` export => everyone is a
 *   spectator (`ctx.seat === null`).
 *
 *   ASYMMETRIC VIEWS (optional — for hidden information). By default every client
 *   receives the SAME state. For games where players must see DIFFERENT things
 *   (a poker hand, a hidden board), export a PURE `view(state, ctx)` that returns
 *   the slice a given viewer may see:
 *
 *     export function view(state, ctx) {       // ctx = { seat, playerId }
 *       // return the projection this seat is allowed to see (hide the rest)
 *     }
 *
 *   The reducer keeps ONE full authoritative state; `view` is the only place
 *   that decides visibility. The coordinator calls it per connection (batched)
 *   and sends each client its own `{type:"state"}` frame. Absent `view` => the
 *   full state is broadcast to everyone (symmetric apps, unchanged).
 *
 *   The client page (served by `fetch`) opens a WebSocket to the host at
 *   `/agents/app-host/<room>`, where <room> is read from the page's own
 *   `location` (`?room=`, default "main") — one page serves any room. It renders
 *   each broadcast `{type:"state"}`. Absent `applyAction` = a non-realtime app.
 */

export interface AppFile {
  path: string;
  content: string;
}

export interface AppTemplate {
  /** Stable id, e.g. "counter". */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  /** The files this template seeds a new app with. */
  files: AppFile[];
  /**
   * Capabilities this app expects the broker to grant.
   * Today "store" (key/value) and "fs" (filesystem) exist. Future: "blob", "room".
   */
  declares: string[];
  /** Entry file. Defaults to "src/index.js" if omitted. */
  entrypoint?: string;
}
