import type { Connection } from "agents";
import type { AppFile } from "../templates/types";
import type { Env } from "../types";
import {
  reduce,
  project,
  seats as appSeats,
  initialState as appInitialState,
  probe as appProbe,
  migrate as appMigrate,
  type ResolvePrebuilt
} from "../agent/runner";

/**
 * REALTIME ENGINE — the shared, app-agnostic multiplayer core.
 *
 * This is the trusted home for everything a realtime app must NOT be given
 * directly: WebSocket connections, presence, seat assignment, persistence, and
 * broadcast. The untrusted app stays a pure function — it only exports
 * `applyAction(state, action, ctx)` (+ optional `initialState`), which the
 * runner invokes in the sandbox on this coordinator's behalf.
 *
 * Approach implemented today: PURE-REDUCER (see README "Multiplayer").
 *   client --ws--> AppHost.onMessage --> coordinator.onMessage
 *     --> runner.reduce(files, state, action, ctx)   [sandboxed, pure]
 *     --> persist new state --> send each client its own view (or broadcast)
 *
 * The reserved `broker.requestRoom()` (app-driven realtime) can later be built
 * as a second consumer of this same engine without changing any of the below.
 *
 * SEAT MODEL (app-agnostic): seat names are DECLARED BY THE APP via an optional
 * `seats` export — the core owns none. The coordinator hands each player an
 * opaque `seat` from that pool (bound to a stable browser token) and passes it
 * to the reducer/view as `ctx.seat`. An app that declares no seats => everyone
 * is a spectator (`seat: null`). The reducer decides what a seat may do; the
 * coordinator never knows the rules.
 *
 * ASYMMETRIC VIEWS (app-agnostic): the shared state is a single source of truth,
 * but each player may see a DIFFERENT slice of it (hidden information — e.g. a
 * poker hand). An app opts in with a pure `view(state, ctx)` export; after every
 * change the coordinator projects the state per connection (batched, in the
 * sandbox) and sends each client its own frame. No `view` export => the full
 * state is broadcast to everyone (symmetric apps like tic-tac-toe, unchanged).
 */

// Persistence keys within the reserved "__room__" app_data scope.
const ROOM_SCOPE = "__room__";
const KEY_STATE = "state";
const KEY_STATE_VERSION = "stateVersion";
const KEY_SEATS = "seats";
const KEY_SEAT_NAMES = "seatNames";

/** A seat is an opaque, app-defined slot label (e.g. "X"/"O", "P1".."P6"). */
type Seat = string;

type Seats = Record<Seat, string>; // seat -> player token

/** Per-connection state we track on the WebSocket itself. */
export interface ConnState {
  token: string;
  seat: Seat | null;
}

/** The slice of AppHost the coordinator needs. Keeps realtime app-agnostic. */
export interface RoomHost {
  name: string;
  env: Env;
  /** Live files + entry of the active app version (for the sandboxed reducer). */
  roomFiles(): AppFile[];
  roomEntrypoint(): string;
  roomActiveVersion(): number;
  /** Broadcast a text frame to every connected client. */
  broadcast(msg: string): void;
  /** All currently-open connections. */
  roomConnections(): Iterable<Connection<ConnState>>;
  /** Persistence in the reserved room scope (backed by app_data SQLite). */
  roomGet(key: string): string | null;
  roomPut(key: string, value: string): void;
  /** Resolve a persisted build for a content hash (skips re-bundling). */
  resolvePrebuilt: ResolvePrebuilt;
}

export class RoomCoordinator {
  #host: RoomHost;

  // Serializes state transitions. Each handler reads → reduces (an async sandbox
  // RPC) → writes; the Durable Object input gate releases during that await, so
  // concurrent frames (e.g. two players acting at once) would otherwise race and
  // clobber each other's writes (lost updates). We chain handlers so every
  // read-modify-write runs to completion before the next one starts.
  #chain: Promise<unknown> = Promise.resolve();

  constructor(host: RoomHost) {
    this.#host = host;
  }

  /** Run `fn` after all previously-queued transitions, one at a time. */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    // Keep the chain alive regardless of individual success/failure.
    this.#chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // ── connection lifecycle (called from AppHost) ──

  onConnect(connection: Connection<ConnState>, token: string): Promise<void> {
    return this.#serialize(async () => {
      // Do this FIRST: if the live app version changed since state was stored,
      // the old state/seats may not match the new reducer — reset before we
      // assign a seat (otherwise we'd wipe the seat we just gave out).
      await this.#ensureFreshState();

      const seat = this.#assignSeat(token, connection);
      connection.setState({ token, seat });

      const state = this.#readState();
      connection.send(JSON.stringify({ type: "welcome", seat }));
      // Send everyone their own (possibly per-player) view: the newcomer gets
      // its first state frame and existing players refresh presence. The
      // newcomer is already in getConnections() (accepted before onConnect).
      await this.#broadcastState(state);
    });
  }

  onMessage(connection: Connection<ConnState>, raw: string): Promise<void> {
    let msg: { type?: string; action?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return Promise.resolve();
    }
    if (msg.type !== "action" || msg.action == null) return Promise.resolve();

    const cs = connection.state;
    const ctx = { seat: cs?.seat ?? null, playerId: cs?.token ?? null };

    return this.#serialize(async () => {
      await this.#ensureFreshState();
      const prev = this.#readState();

      const result = await reduce({
        ...this.#runnerOpts(),
        state: prev,
        action: msg.action,
        ctx
      });

      // A missing/failed reducer or an illegal (unchanged) move → nothing to do.
      if (!result.ok || result.state === undefined) return;

      this.#writeState(result.state);
      await this.#broadcastState(result.state);
    });
  }

  onClose(_connection: Connection<ConnState>): Promise<void> {
    // Seats are bound to tokens and reclaimed lazily (see #assignSeat), so a
    // brief disconnect keeps your seat; a truly-gone player's seat is only taken
    // when another player actually needs it. Just refresh presence for others.
    return this.#serialize(async () => {
      await this.#broadcastState(this.#readState());
    });
  }

  // ── seat assignment (app-agnostic presence) ──

  #assignSeat(token: string, joining: Connection<ConnState>): Seat | null {
    const names = this.#seatNames(); // app-defined pool (empty => spectators only)
    const seats = this.#readSeats();

    // Returning player keeps their seat.
    for (const s of names) if (seats[s] === token) return s;

    // Take an unbound seat.
    for (const s of names) {
      if (!seats[s]) {
        seats[s] = token;
        this.#writeSeats(seats);
        return s;
      }
    }

    // All seats bound: reclaim one whose holder is no longer connected.
    for (const s of names) {
      const holder = seats[s];
      if (holder && !this.#isOnline(holder, joining)) {
        seats[s] = token;
        this.#writeSeats(seats);
        return s;
      }
    }

    // Full house (or no seats declared) → spectator.
    return null;
  }

  #isOnline(token: string, exclude?: Connection<ConnState>): boolean {
    for (const c of this.#host.roomConnections()) {
      if (c === exclude) continue;
      if (c.state?.token === token) return true;
    }
    return false;
  }

  // ── state helpers ──

  /**
   * Bring stored state in line with the live code version, and (re)load the
   * app-defined seat pool. Seat names are owned by the app, so they are
   * refreshed whenever the live version changes (or were never loaded).
   *
   * STATE PRESERVATION (see limitation #1): a code edit bumps the version, but
   * that must NOT automatically wipe an in-progress game. When the version
   * changes and we already hold state, we try to carry it forward, in order:
   *   1. KEEP   — probe the old state against the new bundle; if compatible,
   *               keep it (and the seats) as-is.
   *   2. MIGRATE— else run the app's optional `migrate(old, oldVersion)` and
   *               keep the result if IT probes compatible.
   *   3. RESET  — else reseed from `initialState` and release seats (new game).
   * A cosmetic/logic edit that doesn't touch the state shape therefore leaves
   * the running game untouched.
   */
  async #ensureFreshState(): Promise<void> {
    const storedVersion = this.#host.roomGet(KEY_STATE_VERSION);
    const active = String(this.#host.roomActiveVersion());
    const versionChanged = storedVersion !== active;

    // Refresh the seat pool from the app (the core declares no seat names).
    if (versionChanged || this.#host.roomGet(KEY_SEAT_NAMES) === null) {
      const s = await appSeats(this.#runnerOpts());
      this.#host.roomPut(KEY_SEAT_NAMES, JSON.stringify(s.ok ? s.seats : []));
    }

    const rawState = this.#host.roomGet(KEY_STATE);
    const hasState = rawState !== null;

    // Already current — nothing to do.
    if (hasState && !versionChanged) return;

    // First-ever init: seed from the app. Nothing to preserve, no seats to clear.
    if (!hasState) {
      await this.#seedInitialState(active);
      return;
    }

    // Version changed with existing state: try to preserve it across the edit.
    const oldState = JSON.parse(rawState) as unknown;
    const preserved = await this.#preserveState(oldState, storedVersion);
    if (preserved.kept) {
      this.#host.roomPut(KEY_STATE, JSON.stringify(preserved.state ?? null));
      this.#host.roomPut(KEY_STATE_VERSION, active);
      return; // seats intact — the same game continues on the new code
    }

    // Incompatible and unmigratable → fresh game.
    await this.#seedInitialState(active);
    this.#writeSeats({});
  }

  /** Common runner args for this room's live app version. */
  #runnerOpts() {
    return {
      env: this.#host.env,
      instance: this.#host.name,
      files: this.#host.roomFiles(),
      entrypoint: this.#host.roomEntrypoint(),
      resolvePrebuilt: this.#host.resolvePrebuilt
    };
  }

  /** Seed stored state from the app's `initialState` for the given version. */
  async #seedInitialState(active: string): Promise<void> {
    const seed = await appInitialState(this.#runnerOpts());
    const value = seed.ok ? seed.state : null;
    this.#host.roomPut(KEY_STATE, JSON.stringify(value ?? null));
    this.#host.roomPut(KEY_STATE_VERSION, active);
  }

  /**
   * Try to carry `oldState` (saved by version `oldStoredVersion`) forward to the
   * current code: KEEP if it probes compatible, else MIGRATE + re-probe. Returns
   * `{ kept:false }` when neither works (caller resets to initialState).
   */
  async #preserveState(
    oldState: unknown,
    oldStoredVersion: string | null
  ): Promise<{ kept: boolean; state?: unknown }> {
    // 1. KEEP — is the old state directly usable by the new code?
    const direct = await appProbe({ ...this.#runnerOpts(), state: oldState });
    if (direct.ok && direct.compatible) return { kept: true, state: oldState };

    // 2. MIGRATE — let the app transform it, and keep only if the result probes ok.
    const migrated = await appMigrate({
      ...this.#runnerOpts(),
      state: oldState,
      version: Number(oldStoredVersion ?? 0)
    });
    if (migrated.ok && migrated.state !== undefined) {
      const check = await appProbe({ ...this.#runnerOpts(), state: migrated.state });
      if (check.ok && check.compatible) return { kept: true, state: migrated.state };
    }

    // 3. Give up — caller reseeds.
    return { kept: false };
  }

  #seatNames(): Seat[] {
    const raw = this.#host.roomGet(KEY_SEAT_NAMES);
    return raw ? (JSON.parse(raw) as Seat[]) : [];
  }

  #readState(): unknown {
    const raw = this.#host.roomGet(KEY_STATE);
    return raw ? JSON.parse(raw) : null;
  }

  #writeState(state: unknown): void {
    this.#host.roomPut(KEY_STATE, JSON.stringify(state ?? null));
    this.#host.roomPut(KEY_STATE_VERSION, String(this.#host.roomActiveVersion()));
  }

  #readSeats(): Seats {
    const raw = this.#host.roomGet(KEY_SEATS);
    return raw ? (JSON.parse(raw) as Seats) : {};
  }

  #writeSeats(seats: Seats): void {
    this.#host.roomPut(KEY_SEATS, JSON.stringify(seats));
  }

  // ── broadcast (with optional per-player projection) ──

  /** Live presence per seat: seat -> is a connected player holding it. */
  #players(): Record<Seat, boolean> {
    const seats = this.#readSeats();
    const players: Record<Seat, boolean> = {};
    for (const s of this.#seatNames()) {
      players[s] = Boolean(seats[s] && this.#isOnline(seats[s] as string));
    }
    return players;
  }

  /**
   * Push the new state to every client. If the app exports a pure `view`, each
   * connection is sent its OWN projection (hidden information — batched into a
   * single sandbox call). Otherwise the full state is broadcast to everyone.
   */
  async #broadcastState(state: unknown): Promise<void> {
    const players = this.#players();
    const conns = [...this.#host.roomConnections()];

    if (conns.length > 0) {
      const viewers = conns.map((c) => ({
        key: c.id,
        ctx: { seat: c.state?.seat ?? null, playerId: c.state?.token ?? null }
      }));

      const result = await project({
        ...this.#runnerOpts(),
        state,
        viewers
      });

      if (result.ok && result.views) {
        for (const c of conns) {
          const view = result.views[c.id];
          c.send(JSON.stringify({ type: "state", state: view, players }));
        }
        return;
      }
      // no-view (or a failed projection) → fall through to a full broadcast.
    }

    this.#host.broadcast(JSON.stringify({ type: "state", state, players }));
  }
}
