// Fire-and-forget writer for the service_observations table (W0.8).
// Called from invoke_all.ts on every terminal ServiceEvent (ok/error/fallback).
// Write failures are logged but never propagate — this must not slow or break
// the verify pipeline.

import { getDb } from "../db/client.ts";
import { ObservationStatus } from "../db/enums.ts";
import { log } from "./log.ts";
import type { ServiceEvent } from "../agent/events.ts";

export function recordServiceObservation(event: ServiceEvent): void {
  // Only record terminal events; "start" has no outcome yet.
  if (event.status === "start") return;

  const db = getDb();

  // The transient ServiceEvent statuses collapse to the two persisted values:
  // "fallback" → error, everything else terminal ("ok"/"error") maps 1:1.
  const status: ObservationStatus = event.status === "ok"
    ? ObservationStatus.OK
    : ObservationStatus.ERROR;
  const cost_usd = event.cost_usd != null ? String(event.cost_usd) : null;

  Promise.resolve(
    db`
      INSERT INTO service_observations
        (resource, request_id, status, duration_ms, cost_usd, error_code)
      VALUES
        (${event.resource}, ${event.request_id}, ${status},
         ${event.duration_ms ?? null}, ${cost_usd},
         ${event.error ?? null})
    `,
  ).catch((err: unknown) => {
    log.error(
      "[observations] failed to write service_observation:",
      (err as Error)?.message ?? err,
    );
  });
}
