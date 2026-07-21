/**
 * Per-app resource limits (the "guardrails").
 *
 * DESIGN GOALS (see the roadmap): limits must be
 *   1. GENEROUS by default — they exist to stop accidental runaways (an
 *      AI-generated infinite loop, an unbounded download, a storage leak), NOT to
 *      ration trusted developers. Defaults are deliberately high.
 *   2. CONFIGURABLE per app — every field can be overridden per room via
 *      `AppHost.setLimits` (exposed at `/api/limits`, surfaced later in the
 *      Resources panel). Overrides are stored in AppHost's trusted `__limits__`
 *      scope, so the untrusted app can never raise its own ceilings.
 *
 * This module is the SINGLE source of truth for the shape, the defaults, and the
 * clamps. Every enforcement point (runner, ScopedFetcher, AppData) reads a fully
 * resolved `AppLimits` produced here — never a raw stored blob.
 */

/** Fully-resolved limits for one app. Every field is always present. */
export interface AppLimits {
  // ── compute (per app run, enforced by the Dynamic Worker loader) ──
  /** Max CPU milliseconds for a single app run. */
  cpuMs: number;
  /** Max outbound subrequests (incl. mediated fetches) for a single app run. */
  subRequests: number;

  // ── mediated fetch (env.SYSTEM.requestFetch) ──
  /** Abort a mediated fetch after this many milliseconds. */
  fetchTimeoutMs: number;
  /** Max response body bytes buffered from a mediated fetch. */
  fetchMaxBytes: number;
  /** Max redirect hops to follow (each re-validated against the allowlist). */
  fetchMaxRedirects: number;

  // ── key/value store (env.SYSTEM.requestStore) ──
  /** Max bytes for a single stored value. */
  storeMaxValueBytes: number;
  /** Max total bytes across ALL of an app's store namespaces (soft cap). */
  storeMaxTotalBytes: number;

  // ── email (env.SYSTEM.requestEmail) ──
  /** Max emails an app may send per calendar day (UTC). */
  emailPerDay: number;

  // ── scheduler (env.SYSTEM.requestScheduler) ──
  /** Max simultaneously-pending scheduled tasks (one-shot + recurring). */
  maxScheduledTasks: number;

  // ── SQL database (env.SYSTEM.requestSql) ──
  /** Max rows a single SQL query may return (guards huge result sets over RPC). */
  sqlMaxRows: number;
  /** Max total size of the app's SQL database in bytes (soft cap on growth). */
  sqlMaxDbBytes: number;
}

/**
 * Generous defaults. Chosen to sit comfortably under the Workers platform
 * ceilings while being far larger than any well-behaved app needs, so they only
 * ever catch genuine runaways.
 */
export const DEFAULT_LIMITS: AppLimits = {
  cpuMs: 30_000, // 30s CPU — platform max on paid; a runaway loop is caught here.
  subRequests: 1_000, // Workers paid-plan subrequest ceiling.
  fetchTimeoutMs: 30_000, // 30s per mediated fetch.
  fetchMaxBytes: 25 * 1024 * 1024, // 25 MiB response body.
  fetchMaxRedirects: 5,
  storeMaxValueBytes: 5 * 1024 * 1024, // 5 MiB per value.
  storeMaxTotalBytes: 256 * 1024 * 1024, // 256 MiB per app (soft cap).
  emailPerDay: 200, // 200 sends/day — generous for transactional use.
  maxScheduledTasks: 100, // 100 pending scheduled tasks — ample for timers/cron.
  sqlMaxRows: 50_000, // 50k rows per query — well past any UI need.
  sqlMaxDbBytes: 256 * 1024 * 1024 // 256 MiB SQL database (soft cap).
};

/**
 * Absolute ceilings an override may not exceed (and floors it may not go under).
 * These keep a mis-set override from either breaking the platform (e.g. a cpuMs
 * larger than workerd allows) or disabling a guardrail entirely.
 */
const BOUNDS: Record<keyof AppLimits, { min: number; max: number }> = {
  cpuMs: { min: 50, max: 300_000 },
  subRequests: { min: 1, max: 5_000 },
  fetchTimeoutMs: { min: 100, max: 120_000 },
  fetchMaxBytes: { min: 1024, max: 512 * 1024 * 1024 },
  fetchMaxRedirects: { min: 0, max: 20 },
  storeMaxValueBytes: { min: 1024, max: 25 * 1024 * 1024 },
  storeMaxTotalBytes: { min: 64 * 1024, max: 2 * 1024 * 1024 * 1024 },
  emailPerDay: { min: 0, max: 100_000 },
  maxScheduledTasks: { min: 0, max: 10_000 },
  sqlMaxRows: { min: 1, max: 1_000_000 },
  sqlMaxDbBytes: { min: 64 * 1024, max: 2 * 1024 * 1024 * 1024 }
};

function clamp(field: keyof AppLimits, value: number): number {
  const { min, max } = BOUNDS[field];
  if (!Number.isFinite(value)) return DEFAULT_LIMITS[field];
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Merge a partial override onto a base (defaults unless given), clamping every
 * field to its bounds. Unknown/NaN fields fall back to the base value. This is
 * the ONLY way an `AppLimits` should be constructed from untrusted-ish input.
 */
export function mergeLimits(
  override?: Partial<AppLimits> | null,
  base: AppLimits = DEFAULT_LIMITS
): AppLimits {
  const out = { ...base } as AppLimits;
  if (override && typeof override === "object") {
    for (const key of Object.keys(BOUNDS) as (keyof AppLimits)[]) {
      const v = override[key];
      if (typeof v === "number") out[key] = clamp(key, v);
    }
  }
  // Re-clamp the base too, in case a stored blob predates a bounds change.
  for (const key of Object.keys(BOUNDS) as (keyof AppLimits)[]) {
    out[key] = clamp(key, out[key]);
  }
  return out;
}

/** Parse a stored JSON blob (or null) into fully-resolved limits. */
export function parseLimits(raw: string | null): AppLimits {
  if (!raw) return { ...DEFAULT_LIMITS };
  try {
    return mergeLimits(JSON.parse(raw) as Partial<AppLimits>);
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

/** Trusted AppHost app_data scope + key where per-app overrides are stored. */
export const LIMITS_SCOPE = "__limits__";
export const LIMITS_KEY = "config";
