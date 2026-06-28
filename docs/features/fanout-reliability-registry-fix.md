# fanout-reliability-registry-fix

**What:** Makes the DB the single source of truth for _how_ to invoke each x402
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
active@1.0 — and that file holds only the 4 now-`blocked` services. So the
fan-out resolved each category to exactly one dead service with no alternates.
The 30 healthy probation candidates were uninvokable because the vetter inserted
a registry row but never snapshotted a call recipe for it (promotion deadlock:
probation never gets traffic → never earns observations → never promotes).

## Tickets

1. **Schema** — `db/migrations/0003_service_registry_call_shapes.sql` adds
   nullable, un-indexed
   `method / query_params / path_params / body_schema /
   body_type` columns.
   `ServiceRegistryRow` updated column-for-column.
2. **Selection from DB** — `getActiveServices()` now selects `active` **and**
   `probation` (excludes `blocked`), projects the shape columns, and orders
   `active` ahead of `probation` then by score. New `rowToRanked()` builds the
   `RankedService` straight from the row (network pinned to Base, `payTo` empty
   — neither drives the call). `selectFromRegistry()` branches on `dbEnabled()`:
   prod reads the DB only and a read failure throws `RegistryUnavailableError`
   (mapped to a **503 `registry_unavailable`** in `src/routes/errors.ts`) — no
   silent recipe fallback. Offline (DATABASE_URL unset) keeps the recipe-as-
   active@1.0 path for replay.
3. **Discovery snapshots shapes** — `callShapeFromBazaarInfo()` (in
   `src/discovery/types.ts`) derives the shape from a provider's Bazaar input
   hints; the vetter's `insertCandidate` now writes new candidates **with**
   their shape, so they're immediately invokable. One-time backfill:
   `scripts/backfill-call-shapes.ts` (`deno task backfill:shapes`) re-runs
   discovery and `UPDATE`s shape columns on existing non-blocked rows by
   resource.
4. **maxValue headroom** —
   `maxValueForPrice(price) = min(price × buffer,
   $0.10 ceiling)`, buffer
   from `INVOKE_MAXVALUE_BUFFER` (default 1.5). Absorbs modest upstream price
   drift instead of an instant `payment_exceeds_max` hard error; the vetter
   reconciles the stored price on its next run.
5. **Promotion deadlock self-heals** — with probation now both _selected_
   (Ticket 2) and _invokable_ (Ticket 3), probation services receive real
   traffic → accumulate `service_observations` → `recomputeScores()` promotes
   them to `active` at reliability ≥ 0.80. **But the loop was silently broken by
   a status-vocabulary mismatch (see "Keystone bug" below) — fixing that is what
   actually closes it.**

## Keystone bug — scoring counted a status that is never written

The deeper root cause (found during the prod e2e, beyond the plan's original
diagnosis): `score.ts` computed reliability as
`COUNT(*) FILTER (WHERE status = 'success')`, but the observation writer
(`src/observability/observations.ts`) records successes as **`'ok'`** (covering
both the pattern `ok` and LLM `fallback_ok` outcomes; `invoke_all.ts:346`) and
failures as `'error'`. The `service_observations` table only ever holds `ok` /
`error` — **never `success`**. So `recomputeScores()` computed **0 successes →
0.0 reliability for _every_ service**, demoting them all
`active → probation → blocked`. That is the true engine of the "0 active
services" deadlock; the plan's "probation never gets traffic" was a downstream
symptom. Fix: count `status = 'ok'`
([src/registry/score.ts](src/registry/score.ts)). Verified against prod:
anchor-x402 went from a counted 0.0 to its real **0.947** reliability (18 `ok` /
1 `error`).

## Files

- `db/migrations/0003_service_registry_call_shapes.sql` (new)
- `src/db/types.ts` — `ServiceRegistryRow` + shape columns
- `src/registry/types.ts` — `RegistryEntry` + shape fields
- `src/registry/read.ts` — `getActiveServices` (active+probation, shape cols,
  tier order), new `rowToRanked`
- `src/registry/select.ts` — `dbEnabled()` branch, `RegistryUnavailableError`,
  DB-only prod path
- `src/registry/select_test.ts` — rewritten for the dbEnabled branch (cases a–d)
- `src/routes/errors.ts` — 503 `registry_unavailable` mapping
- `src/discovery/types.ts` — `CallShape` + `callShapeFromBazaarInfo`
- `src/vetter/run.ts` — `insertCandidate` threads + persists the call shape
- `src/vetter/run_test.ts` — shape-threading test
- `src/registry/score.ts` — **keystone fix**: count `status = 'ok'` (was
  `'success'`, which matched nothing)
- `src/agent/invoke_service.ts` — `maxValueForPrice` headroom
- `src/agent/invoke_service_test.ts` — maxValue tests
- `src/testing/fetch_interceptor.ts` — strip `maxValue` from the replay key (see
  Notes)
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
  query that some `probation` rows have crossed to `active` (reliability ≥
  0.80).

## Prod verification (done this session, against `super-grass-68246474`)

Full e2e was run against the **prod** Neon DB (the local `.env` dev DB has dead
credentials). Sequence + results:

1. **Migration applied** to prod (`deno run … scripts/migrate.ts` with a prod
   connection string) — `describe_table_schema` confirms the 5 shape columns,
   nullable, un-indexed. (CI's `migrate` job will be a no-op for `0003` on
   merge.)
2. **Backfill ran** (`backfill:shapes`) — 21 registry rows updated with shapes.
   Every category now has ≥1 shaped candidate (labels 2, onchain 9, sanctions 9,
   web_sentiment 1). ~9 stale rows (openapi/info sub-paths, dropped services)
   aren't surfaced by live discovery and stay `method IS NULL` — best-effort.
3. **Paid e2e (Vitalik) initially CRASHED** with `SanctionsInvocationError`: the
   live catalog is mostly dead (orbisapi now returns "Target API is not X402
   enabled"), and the only working sanctions service, **anchor-x402, was
   `blocked`** (so excluded). The offline-recipe path doesn't filter on status,
   so it still worked — i.e. excluding `blocked` was a regression here.
4. **Data fix:** un-blocked anchor-x402 → `active` + wrote its `GET`/`{wallet}`
   shape. Paid e2e re-run: `verdict=safe_to_transact`, sanctions
   `ok paid=true
   $0.001` via anchor-x402, full pipeline ~16s — parity with
   the current recipe-path prod, now via the DB.
5. **Keystone bug found & fixed** (see above): anchor-x402's 18-`ok`/1-`error`
   history scored 0.0 under the old `'success'` filter, so a vetter `recompute`
   would have re-demoted it within ~24h. After the `'ok'` fix, recompute (run
   against prod) kept anchor-x402 **active at score 0.926** and demoted 6
   genuinely-dead probation orbis services to `blocked`. **Final prod state: 1
   active / 24 probation / 9 blocked** (was 0 / 30 / 4).

**Catalog-health caveat (separate from this fix):** most discovered probation
services are dead upstreams (orbisapi de-x402'd). This change restores the
_mechanism_ (DB selection, probation fallback, correct scoring, self-healing)
but cannot manufacture healthy services. With scoring fixed, dead services now
self-demote to `blocked` and healthy ones can finally be promoted — but the
catalog needs fresh, live x402 services for fan-out to return to multi-signal
verdicts. Today only sanctions (anchor-x402) + the free chain primitives
(oracle, eth-labels, ENS) reliably resolve.
