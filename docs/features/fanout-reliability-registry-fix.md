# fanout-reliability-registry-fix

**What:** Makes the DB the single source of truth for *how* to invoke each x402
service (call shapes move into `service_registry`), lets selection fall back to
`probation` candidates, fails loudly instead of silently serving a stale
4-service sample when the registry read errors, and gives the per-call x402
budget headroom so small upstream price drift no longer hard-fails. Together
these break the "0 active services → deadlock" that had degraded fan-out
reliability.

## Root cause (recap)

After discovery was removed from the hot path, prod ended with **0 `active`**,
30 `probation`, 4 `blocked` registry rows. Selection only treated DB rows as the
active set when `active.length > 0`, so with 0 active it silently fell into the
offline `else` branch that treats every recipe in `data/call_recipes.json` as
active@1.0 — and that file holds only the 4 now-`blocked` services. So the fan-out
resolved each category to exactly one dead service with no alternates. The 30
healthy probation candidates were uninvokable because the vetter inserted a
registry row but never snapshotted a call recipe for it (promotion deadlock:
probation never gets traffic → never earns observations → never promotes).

## Tickets

1. **Schema** — `db/migrations/0003_service_registry_call_shapes.sql` adds
   nullable, un-indexed `method / query_params / path_params / body_schema /
   body_type` columns. `ServiceRegistryRow` updated column-for-column.
2. **Selection from DB** — `getActiveServices()` now selects `active` **and**
   `probation` (excludes `blocked`), projects the shape columns, and orders
   `active` ahead of `probation` then by score. New `rowToRanked()` builds the
   `RankedService` straight from the row (network pinned to Base, `payTo` empty —
   neither drives the call). `selectFromRegistry()` branches on `dbEnabled()`:
   prod reads the DB only and a read failure throws `RegistryUnavailableError`
   (mapped to a **503 `registry_unavailable`** in `src/routes/errors.ts`) — no
   silent recipe fallback. Offline (DATABASE_URL unset) keeps the recipe-as-
   active@1.0 path for replay.
3. **Discovery snapshots shapes** — `callShapeFromBazaarInfo()` (in
   `src/discovery/types.ts`) derives the shape from a provider's Bazaar input
   hints; the vetter's `insertCandidate` now writes new candidates **with** their
   shape, so they're immediately invokable. One-time backfill:
   `scripts/backfill-call-shapes.ts` (`deno task backfill:shapes`) re-runs
   discovery and `UPDATE`s shape columns on existing non-blocked rows by resource.
4. **maxValue headroom** — `maxValueForPrice(price) = min(price × buffer,
   $0.10 ceiling)`, buffer from `INVOKE_MAXVALUE_BUFFER` (default 1.5). Absorbs
   modest upstream price drift instead of an instant `payment_exceeds_max` hard
   error; the vetter reconciles the stored price on its next run.
5. **Promotion deadlock self-heals** — with probation now both *selected*
   (Ticket 2) and *invokable* (Ticket 3), probation services receive real
   traffic → accumulate `service_observations` → the existing
   `recomputeScores()` promotes them to `active` at reliability ≥ 0.80. No new
   mechanism; the loop simply closes once a vetter run + live traffic happen.

## Files

- `db/migrations/0003_service_registry_call_shapes.sql` (new)
- `src/db/types.ts` — `ServiceRegistryRow` + shape columns
- `src/registry/types.ts` — `RegistryEntry` + shape fields
- `src/registry/read.ts` — `getActiveServices` (active+probation, shape cols, tier order), new `rowToRanked`
- `src/registry/select.ts` — `dbEnabled()` branch, `RegistryUnavailableError`, DB-only prod path
- `src/registry/select_test.ts` — rewritten for the dbEnabled branch (cases a–d)
- `src/routes/errors.ts` — 503 `registry_unavailable` mapping
- `src/discovery/types.ts` — `CallShape` + `callShapeFromBazaarInfo`
- `src/vetter/run.ts` — `insertCandidate` threads + persists the call shape
- `src/vetter/run_test.ts` — shape-threading test
- `src/agent/invoke_service.ts` — `maxValueForPrice` headroom
- `src/agent/invoke_service_test.ts` — maxValue tests
- `src/testing/fetch_interceptor.ts` — strip `maxValue` from the replay key (see Notes)
- `scripts/backfill-call-shapes.ts` (new) + `deno task backfill:shapes`
- `.env.example` — `INVOKE_MAXVALUE_BUFFER`

## Config

- `INVOKE_MAXVALUE_BUFFER` (optional, default `1.5`) — per-call x402 budget
  headroom multiplier; effective cap is `min(price × buffer, $0.10)`.
- The backfill needs `DATABASE_URL` + `AGNIC_API_KEY`.

## Notes / gotchas

- **Cassette key now strips `maxValue`.** The agnic fetch URL carries the
  per-call budget cap as a `maxValue` query param, and the offline cassette key
  is `METHOD:URL`. Ticket 4 changed `maxValue` (exact price → buffered), which
  would have invalidated every recorded cassette. `maxValue` is a client-side
  budget knob, not part of the upstream's response identity, so
  `fetch_interceptor.ts` normalizes it out of the key (and rebuilds the replay
  queue via `makeKey(entry.request.url, …)` so pre-existing cassettes match).
  **No re-record** — replay stays 9/9 against the byte-identical cassettes.
- **`data/call_recipes.json` is demoted** to a 4-entry offline/replay sample +
  seed only; it is never read on the production path. Left byte-identical.
- **`service_registry` stores no per-row `network`/`payTo`.** Neither is needed
  to drive the call (Agnic settles payment from the upstream's own 402; `payTo`
  is informational), so `rowToRanked` pins `network=eip155:8453`, `payTo=""`.
- **Prod rollout is two ordered steps:** (1) merge → CI applies `0003` to the
  prod DB (the `migrate` job, gated to `main` pushes); (2) run
  `deno task backfill:shapes` against prod (needs the 0003 columns to exist
  first) to populate shapes on the 30 existing probation rows. Until the
  backfill runs, those rows have `method IS NULL` and the invocation adapter
  falls back to pattern defaults.
- **Self-heal verification (Ticket 5)** is observational: after the backfill +
  one vetter run + live `/verify-agent` traffic, confirm via a read-only Neon
  query that some `probation` rows have crossed to `active` (reliability ≥ 0.80).
