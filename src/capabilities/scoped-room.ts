import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { AppRoomBridge, Env, RoomPresence } from "../types";

/**
 * APP-DRIVEN REALTIME — a mediated handle to the app's own connected clients,
 * handed to an app by the broker (`requestRoom`).
 *
 * The framework's DEFAULT realtime path is the PURE REDUCER (the app exports
 * `applyAction`; the coordinator owns sockets/seats/state/broadcast — see
 * src/realtime/). `requestRoom` is the ESCAPE HATCH for the other direction:
 * pushing to connected clients from the app's OWN code — e.g. an HTTP endpoint,
 * an incoming webhook, or (soon) a scheduled task — instead of only reacting to a
 * WebSocket action.
 *
 * The app is a pure per-request function and never holds a socket. This stub
 * reaches the room's live connections by RPC into AppHost (the DO that owns
 * them), exactly like ScopedEmail reaches the email policy. It can:
 *   - `broadcast(msg)` — fan a message out to every connected client,
 *   - `send(seat, msg)` — message only the client(s) in a given seat,
 *   - `presence()`     — read the seat pool + who's currently connected.
 *
 * Every message is delivered as a `{ type: "app", data: <msg> }` frame, so it
 * never collides with the coordinator's own `welcome`/`state`/`reload` frames —
 * the app's client just handles `type === "app"`.
 *
 * SCOPE (deliberate): this does NOT expose the coordinator's shared `__room__`
 * state. An app-driven app keeps its own state via `requestStore` and pushes
 * changes with `broadcast`; the reducer path keeps owning `__room__`. Keeping the
 * two state models separate avoids racing the coordinator's version/seat logic.
 */
export type ScopedRoomProps = {
  instance: string;
};

export class ScopedRoom extends WorkerEntrypoint<Env, ScopedRoomProps> {
  #host(): Promise<AppRoomBridge> {
    return getAgentByName(
      this.env.AppHost,
      this.ctx.props.instance
    ) as unknown as Promise<AppRoomBridge>;
  }

  /**
   * Broadcast a JSON-serializable message to every connected client of this room
   * (editor spectators excluded). Returns how many clients received it.
   */
  async broadcast(message: unknown): Promise<number> {
    return (await this.#host()).appBroadcast(message);
  }

  /**
   * Send a JSON-serializable message only to the client(s) currently holding
   * `seat` (a seat name from the app's `seats` export). Returns the count sent
   * (0 if nobody holds that seat right now).
   */
  async send(seat: string, message: unknown): Promise<number> {
    if (typeof seat !== "string" || seat.length === 0) {
      throw new Error("requestRoom: send(seat, message) requires a non-empty seat name.");
    }
    return (await this.#host()).appSendToSeat(seat, message);
  }

  /**
   * Read live presence: the app-declared seat pool, which seats are held by a
   * connected client, and the total connected client count.
   */
  async presence(): Promise<RoomPresence> {
    return (await this.#host()).appPresence();
  }
}
