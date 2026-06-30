// Fire-and-forget writer for the usage_events table (W1.2) — the per-request
// trace stream (route / phase / verdict / cost / tenant), distinct from the
// per-service-call service_observations.ts stream. Emitted once at the terminal
// verdict of a verify run (see agent/verify.ts), so REST and MCP both get a row
// for free. Same contract as observations.ts: non-blocking, never throws — a
// write failure is logged but must not slow or break the verdict.

import { type Db, getDb } from "../db/client.ts";
import { log } from "./log.ts";
import { currentTenantId } from "./request_context.ts";

export interface UsageEvent {
  /** The run's request id (the trace key shared with service_observations). */
  request_id: string;
  /** Where the run originated, e.g. "verify-agent" / "mcp:get_deep_verdict". */
  route: string;
  /** The final verdict string, or null if the run produced none. */
  verdict: string | null;
  /** x402 paid-service spend for the run (USDC). */
  cost_usd: number | null;
  /** Optional pipeline phase / tier marker. */
  phase?: string | null;
  /** Optional wall-clock duration of the run in ms. */
  duration_ms?: number | null;
  /**
   * Whether the run reached a terminal verdict. Only terminal runs are
   * persisted — mirrors the service_observations "start" skip so an in-flight
   * event never lands a row. Defaults to true (the single end-of-run call).
   */
  terminal?: boolean;
}

/**
 * Record one usage_events row for a completed verify run. `db` is injectable
 * for hermetic tests; real callers leave it undefined (uses the shared client,
 * which is a no-op when DATABASE_URL is unset). tenant_id is read from ambient
 * context (null for anonymous runs).
 */
export function recordUsageEvent(event: UsageEvent, db: Db = getDb()): void {
  // Only persist terminal runs; an in-flight event has no outcome yet.
  if (event.terminal === false) return;

  // Ambient attribution: the tenant of the issued key that triggered this run
  // (null for anonymous/keyless runs). Bound by the caller via the request
  // context (see request_context.ts).
  const tenantId = currentTenantId();
  // postgres.js stores numeric() as a string; normalize cost the same way the
  // service_observations writer does.
  const cost_usd = event.cost_usd != null ? String(event.cost_usd) : null;

  Promise.resolve(
    db`
      INSERT INTO usage_events
        (tenant_id, request_id, route, phase, duration_ms, cost_usd, verdict)
      VALUES
        (${tenantId}, ${event.request_id}, ${event.route},
         ${event.phase ?? null}, ${event.duration_ms ?? null},
         ${cost_usd}, ${event.verdict})
    `,
  ).catch((err: unknown) => {
    log.error(
      "[usage] failed to write usage_event:",
      (err as Error)?.message ?? err,
    );
  });
}
