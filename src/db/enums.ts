// Single source of truth for the status strings persisted in service_registry
// and service_observations. These are deliberately centralized: a one-character
// drift between a bare literal and the value the DB actually stores (the
// `success` vs `ok` bug fixed in PR #75) compiled and shipped silently because
// the literals were scattered across TS comparisons and inline SQL with no
// shared definition.
//
// Rule: never write these status values as bare string literals. Reference the
// constants in both TS comparisons and SQL (postgres.js parameterizes
// `${ServiceStatus.ACTIVE}` and `= ANY(${[...]})`), so a rename is a type error,
// not a runtime miscount.
//
// NOTE: tenants.status also uses an "active" string, but that is a separate
// billing domain (db/migrations/0001_init.sql) and is intentionally NOT modeled
// here.

/**
 * service_registry.status — the lifecycle of a curated x402 service.
 *
 *   vetting   → freshly seeded, not yet scored
 *   active    → selectable, top tier
 *   probation → selectable fallback tier; accrues observations toward promotion
 *   blocked   → excluded from selection (lifted only by explicit operator retry)
 */
export const ServiceStatus = {
  ACTIVE: "active",
  PROBATION: "probation",
  BLOCKED: "blocked",
  VETTING: "vetting",
} as const;
export type ServiceStatus = (typeof ServiceStatus)[keyof typeof ServiceStatus];

/**
 * service_observations.status — the terminal outcome persisted per call.
 *
 * Only `ok`/`error` are ever stored: observations.ts maps the transient
 * ServiceEvent `fallback` status to `error`, and the LLM-fallback `fallback_ok`
 * outcome is emitted as an `ok` event. score.ts counts `ok` as a success.
 */
export const ObservationStatus = {
  OK: "ok",
  ERROR: "error",
} as const;
export type ObservationStatus =
  (typeof ObservationStatus)[keyof typeof ObservationStatus];
