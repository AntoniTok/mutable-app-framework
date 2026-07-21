import { WorkerEntrypoint, exports } from "cloudflare:workers";
import type { Env } from "../types";
import type { ScopedBlobStore, ScopedBlobStoreProps } from "./scoped-blob-store";
import type { ScopedEmail, ScopedEmailProps } from "./scoped-email";
import type { ScopedFilesystem, ScopedFilesystemProps } from "./scoped-filesystem";
import type { ScopedFetcher, ScopedFetcherProps } from "./scoped-fetcher";
import type { ScopedRoom, ScopedRoomProps } from "./scoped-room";
import type { ScopedScheduler, ScopedSchedulerProps } from "./scoped-scheduler";
import type { ScopedSecrets, ScopedSecretsProps } from "./scoped-secrets";
import type { ScopedSql, ScopedSqlProps } from "./scoped-sql";
import type { ScopedStore, ScopedStoreProps } from "./scoped-store";

/**
 * The capability broker — the ONLY power a running app starts with.
 *
 * The untrusted app cannot touch storage, secrets, or the network on its own.
 * It must call the broker and ASK. The broker validates the request, applies
 * policy, and hands back a narrow, pre-scoped capability stub.
 *
 * This is the growth point of the whole system: new resources (R2 blobs, KV,
 * realtime rooms) slot in here as new `request*` methods, without changing the
 * app contract or the runner.
 */
export type CapabilityBrokerProps = {
  instance: string;
};

// Self-referential access to this worker's exported entrypoints, used to mint
// capability stubs to hand back to the app.
type LoaderExports = {
  ScopedStore(options: { props: ScopedStoreProps }): ScopedStore;
  ScopedFilesystem(options: { props: ScopedFilesystemProps }): ScopedFilesystem;
  ScopedBlobStore(options: { props: ScopedBlobStoreProps }): ScopedBlobStore;
  ScopedFetcher(options: { props: ScopedFetcherProps }): ScopedFetcher;
  ScopedSecrets(options: { props: ScopedSecretsProps }): ScopedSecrets;
  ScopedEmail(options: { props: ScopedEmailProps }): ScopedEmail;
  ScopedRoom(options: { props: ScopedRoomProps }): ScopedRoom;
  ScopedScheduler(options: { props: ScopedSchedulerProps }): ScopedScheduler;
  ScopedSql(options: { props: ScopedSqlProps }): ScopedSql;
};
const runtimeExports = exports as unknown as LoaderExports;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export class CapabilityBroker extends WorkerEntrypoint<
  Env,
  CapabilityBrokerProps
> {
  /**
   * Grant a private key/value store, backed by the app's own SQLite.
   * Available today.
   */
  async requestStore(namespace: string): Promise<ScopedStore> {
    if (!NAME_RE.test(namespace)) {
      throw new Error(
        `Invalid store namespace: "${namespace}". Use letters, digits, "-" or "_".`
      );
    }
    return runtimeExports.ScopedStore({
      props: { instance: this.ctx.props.instance, namespace }
    });
  }

  /**
   * Grant a private filesystem, backed by @cloudflare/dofs in the app's own
   * SQLite. Available today.
   *
   * For small, structured per-app data (notes, config, game history) — folders,
   * readdir, stat, grep/find. NOT a blob store: files are capped at 256 KiB.
   * Large binaries belong in R2 via the reserved `requestBlobStore` hook below.
   */
  async requestFilesystem(namespace: string): Promise<ScopedFilesystem> {
    if (!NAME_RE.test(namespace)) {
      throw new Error(
        `Invalid filesystem namespace: "${namespace}". Use letters, digits, "-" or "_".`
      );
    }
    return runtimeExports.ScopedFilesystem({
      props: { instance: this.ctx.props.instance, namespace }
    });
  }

  /**
   * Grant a private BLOB store (large binary objects) backed by R2. For images,
   * audio, exports — anything too big for the 256 KiB filesystem cap. Keys are
   * confined to a per-app, per-namespace prefix.
   */
  async requestBlobStore(namespace: string): Promise<ScopedBlobStore> {
    if (!NAME_RE.test(namespace)) {
      throw new Error(
        `Invalid blob namespace: "${namespace}". Use letters, digits, "-" or "_".`
      );
    }
    return runtimeExports.ScopedBlobStore({
      props: { instance: this.ctx.props.instance, namespace }
    });
  }

  /**
   * Grant a MEDIATED outbound fetch capability. The app sandbox itself keeps
   * `globalOutbound: null` (no direct egress); this capability performs the
   * request in trusted host code, but ONLY to hosts on the app's per-app
   * allowlist (held in trusted storage, not settable by the app). Requests to
   * any other host are rejected. This is how an app reaches the outside world
   * without ever being handed raw network access.
   */
  async requestFetch(): Promise<ScopedFetcher> {
    return runtimeExports.ScopedFetcher({
      props: { instance: this.ctx.props.instance }
    });
  }

  /**
   * Grant a READ-ONLY view of the app's secrets (API keys / credentials the user
   * configured for this room). Secrets follow a use-not-read model: prefer
   * INJECTING them (e.g. `requestFetch().send(url, { secretHeaders: {...} })`),
   * which never exposes the value. This capability's `get(name)` returns the raw
   * value ONLY for secrets the user explicitly flagged `readable`; `has`/`list`
   * reveal names only. The app can never SET a secret — that's host-only policy.
   */
  async requestSecrets(): Promise<ScopedSecrets> {
    return runtimeExports.ScopedSecrets({
      props: { instance: this.ctx.props.instance }
    });
  }

  /**
   * Grant a MEDIATED transactional-email capability. The app never touches the
   * `EMAIL` binding; `ScopedEmail.send()` validates the send against the app's
   * trusted policy (allowed senders/recipients + daily cap) before it goes out.
   * The app can't spoof an arbitrary `From` or exceed its cap.
   */
  async requestEmail(): Promise<ScopedEmail> {
    return runtimeExports.ScopedEmail({
      props: { instance: this.ctx.props.instance }
    });
  }

  /**
   * Grant an APP-DRIVEN REALTIME handle to this room's connected clients. The
   * DEFAULT realtime path is the pure `applyAction` reducer (the coordinator owns
   * sockets/seats/state); this is the escape hatch for PUSHING to clients from
   * the app's own code (an HTTP endpoint, a webhook, a scheduled task) via
   * `broadcast`/`send`/`presence`. The app still holds no socket — the stub reaches
   * the live connections (which live in AppHost) by RPC. Messages arrive as
   * `{ type: "app", data }` frames.
   */
  async requestRoom(): Promise<ScopedRoom> {
    return runtimeExports.ScopedRoom({
      props: { instance: this.ctx.props.instance }
    });
  }

  /**
   * Grant a per-app TASK SCHEDULER. The app schedules future work — `after`
   * (delay), `at` (absolute time), or `every` (recurring) — and the framework
   * later runs the app's `onSchedule(env, ctx)` export when each task comes due,
   * in the normal sandbox (so the task can persist, fetch, email, or broadcast
   * via requestRoom). Backed by the per-room AppScheduler DO (its own SQLite +
   * a DO alarm). Pending tasks are capped by the trusted `maxScheduledTasks` limit.
   */
  async requestScheduler(): Promise<ScopedScheduler> {
    return runtimeExports.ScopedScheduler({
      props: { instance: this.ctx.props.instance }
    });
  }

  /**
   * Grant a private RELATIONAL SQL database (its OWN SQLite, one per room). Unlike
   * `requestStore` (a flat key/value store), this is a real SQL surface: the app
   * defines its own tables and runs arbitrary queries with bound parameters
   * (`exec`/`query`/`first`/`run`). Backed by the per-room AppSql DO, reached
   * directly by the stub (limitation #3). Guardrails: a per-query row cap
   * (`sqlMaxRows`) and a DB-size soft cap (`sqlMaxDbBytes`), both trusted limits.
   */
  async requestSql(): Promise<ScopedSql> {
    return runtimeExports.ScopedSql({
      props: { instance: this.ctx.props.instance }
    });
  }
}
