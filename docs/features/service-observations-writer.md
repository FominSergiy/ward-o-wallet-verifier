## service-observations-writer (W0.8)

**What:** Fire-and-forget writer that inserts a `service_observations` row for every terminal ServiceEvent (ok/error/fallback) emitted by the invoke pipeline, feeding future reputation scoring (W2) and graph-training labels (W4).

**Files:**
- `src/observability/observations.ts` (new) — `recordServiceObservation(event)` function
- `src/agent/invoke_all.ts` — hooked at all four terminal emit sites
- `src/observability/observations_test.ts` (new) — 6 unit tests

**Config:** none — uses the existing `DATABASE_URL`-gated `getDb()`. No-op when DB is unset.

**Notes:**
- Only terminal events (ok, error, fallback) are written; "start" is skipped early.
- "fallback" status is stored as "error" in the DB (the row captures the resource that failed, not the one that ultimately succeeded).
- `severity_contribution` and `outcome_label` columns are left NULL (dormant until W2.1 / W4).
