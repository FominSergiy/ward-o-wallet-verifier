**What:** Centralized the status strings persisted in `service_registry` and `service_observations` into one `as const` + union-type module (`src/db/enums.ts`), typed the DB row fields off those unions, and interpolated the constants into the SQL — so the `success`/`ok` literal drift that PR #75 fixed by hand becomes a compile error, not a silent runtime miscount.

**Files:**
- `src/db/enums.ts` (new) — `ServiceStatus` (`active`/`probation`/`blocked`/`vetting`) and `ObservationStatus` (`ok`/`error`) `as const` objects + derived union types. The single source of truth.
- `src/db/enums_test.ts` (new) — pins each constant's runtime string value (locks the DB contract) and asserts union exhaustiveness against the constants.
- `src/db/types.ts` — `ServiceRegistryRow.status: ServiceStatus`, `ServiceObservationRow.status: ObservationStatus`.
- `src/registry/types.ts` — `RegistryEntry.status: ServiceStatus`.
- `src/registry/score.ts` — `RegistrySummary.status`, `nextStatus()` param/return, and `RecomputeOpts.applyUpdate` status arg typed `ServiceStatus`; `nextStatus` switch-arms use the constants; the keystone SQL line is now `FILTER (WHERE status = ${ObservationStatus.OK})`.
- `src/registry/read.ts` — `getActiveServices` selects via `status = ANY(${[ServiceStatus.ACTIVE, ServiceStatus.PROBATION]})` and orders by `(status = ${ServiceStatus.ACTIVE})`.
- `src/observability/observations.ts` — local persisted `status` narrowed to `ObservationStatus`; `fallback`→`error` collapse expressed against the constants.
- `src/vetter/run.ts` — `RegistryRow.status`/`updateStatus`/`defaultUpdateStatus` typed `ServiceStatus`; `WHERE status = ANY(...)`, the probation insert, and the probation transition use the constants.
- `scripts/seed-registry.ts`, `scripts/backfill-call-shapes.ts` — `'active'`/`status <> 'blocked'` literals replaced with `${ServiceStatus.*}`.
- Tests re-based on the constants: `src/registry/read_test.ts`, `src/registry/score_test.ts`, `src/registry/select_test.ts`.

**Config:** none. No new env vars, no migration, no dependency. postgres.js parameterizes the interpolated constants (`${...}` and `= ANY(${[...]})`) — no `db.unsafe`, no injection surface.

**Notes:**
- **Scope was deliberately the DB-persisted seam only.** `ServiceEvent.status` (`start`/`ok`/`error`/`fallback`) and the invoke-outcome unions are an app-layer concern and were left as-is; the `event.status === "ok"` comparison in `observations.ts` is that event-layer check, not the persisted value. `tenants.status` is a separate billing domain and is untouched.
- **No DB CHECK-constraint migration** — chosen as out of scope. The DB still stores plain `text`; enforcement is at the TS layer + parameterized SQL. A future migration adding `CHECK (status IN (...))` is the remaining DB-side hardening if desired (would need a prod-data audit first).
- **No cassette re-record** — logic-only, no HTTP request shape change (per the CLAUDE.md cutover rule).
- The `score.ts` keystone SQL is still not unit-covered (its tests stub `fetchMetrics`); the `enums_test.ts` value-pinning is the guard that keeps `ObservationStatus.OK === "ok"` from silently re-drifting.
- Follow-up captured separately: `docs/plans/planned/orm-evaluation.md` evaluates whether a query builder/ORM would better prevent this class of drift (recommendation: a scoped Kysely spike, not a full ORM).
