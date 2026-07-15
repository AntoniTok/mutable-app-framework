import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../types";

/**
 * Per-run observability for the untrusted app's Dynamic Worker.
 *
 * A Dynamic Worker runs in its own context, so its `console.log()` calls,
 * thrown exceptions, and outcome are NOT captured by the host worker's Workers
 * Logs automatically. To keep them, we attach this Tail Worker to every dynamic
 * app run (see runner.ts `tails: [...]`).
 *
 * The runtime invokes `tail()` AFTER the dynamic run finishes (off the request
 * path, so it adds no latency), handing us everything it collected. We re-emit
 * each entry with `console.log()` here — and because THIS class lives in the
 * host worker (which has `observability` enabled in wrangler.jsonc), those lines
 * land in Workers Logs. Every entry is tagged with `workerId` so logs can be
 * filtered/searched per app version (the id embeds a content hash of the code).
 */
export interface DynamicWorkerTailProps {
  /** Which dynamic app worker produced these logs (e.g. "app-<room>-<hash>"). */
  workerId: string;
}

export class DynamicWorkerTail extends WorkerEntrypoint<Env, DynamicWorkerTailProps> {
  async tail(events: TraceItem[]): Promise<void> {
    const workerId = this.ctx.props.workerId;

    for (const event of events) {
      for (const log of event.logs) {
        console.log({
          source: "dynamic-app",
          workerId,
          level: log.level,
          message: log.message,
          ts: log.timestamp
        });
      }

      for (const ex of event.exceptions) {
        console.error({
          source: "dynamic-app",
          workerId,
          name: ex.name,
          message: ex.message,
          stack: ex.stack,
          ts: ex.timestamp
        });
      }

      // Surface non-clean outcomes (exceptions, exceededCpu, ...) plus timing,
      // so a crash or runaway app version is visible even with no logs emitted.
      if (event.outcome && event.outcome !== "ok") {
        console.log({
          source: "dynamic-app",
          workerId,
          outcome: event.outcome,
          cpuTimeMs: event.cpuTime,
          wallTimeMs: event.wallTime
        });
      }
    }
  }
}
