# labels-payable-service-filter

**What:** Registry selection now skips any service priced above the per-call USDC
cap, so unpayable services can no longer win the primary/fallback slot and fail
100% of the time — fixing the prod `labels` path that kept selecting $0.15–$1.50
services rejected with `Payment exceeds maximum allowed value`.

## Root cause

Three correct-in-isolation pieces left a gap:

1. Per-call authorization is capped at `MAXVALUE_CEILING_USDC = 0.10`
   (`src/agent/invoke_service.ts`) — anything pricier can never be paid.
2. Selection (`src/registry/select.ts`) ranked candidates by `status` then
   `score` and filtered only `blocked`/denied-host — **never price** vs. the cap.
3. Scoring (`src/registry/score.ts`) *deliberately* excludes
   `payment exceeds maximum` failures from reliability (so a price-drifted
   service isn't permanently blocked). Side effect: an over-cap service keeps its
   score, is never demoted, and keeps winning — failing every call forever.

## Change

- **`isPayable(priceUsdc)`** added to `src/agent/invoke_service.ts`, derived from
  `maxValueForPrice` (`maxValueForPrice(p) >= p`) so the selection filter can
  never drift from the actual payment authorization.
- **`src/registry/select.ts`** — DB/production path skips `!isPayable(price)`
  candidates alongside the existing `blocked`/`isDeniedHost` guards, emitting a
  `registry_select: skip … exceeds per-call cap` log. Removes the service from
  both the primary slot and the `alternates` fallback chain. The offline recipe
  branch is untouched (replay fixtures unaffected).

## Files

- `src/agent/invoke_service.ts` — `isPayable` helper.
- `src/registry/select.ts` — price-cap filter (DB path only).
- `src/agent/invoke_service_test.ts` — `isPayable` unit test.
- `src/registry/select_test.ts` — 3 tests: over-cap primary skipped, all-over-cap
  → unresolved, offline path not filtered.
- prod DB (`service_registry`) — one-off data cleanup, no migration (see below).

## Config

None. No new env vars. The cap remains the existing hardcoded
`MAXVALUE_CEILING_USDC = 0.10` (buffer still tunable via `INVOKE_MAXVALUE_BUFFER`).

## Prod data cleanup (one-off, applied 2026-07-20)

Blocked 7 unpayable/miscategorized rows so the vetter stops probing them:
- 6 rows via `UPDATE service_registry SET status='blocked' WHERE status IN
  ('active','probation') AND price_usdc > 0.10` — 4 `labels` ($0.15–$2.50) and 2
  `sanctions` `chain-analyzer.com` rows ($0.50, score 1.0 — would have seized the
  sanctions primary the moment active `anchor-x402` degraded).
- 1 more: `obol-x402.fly.dev/v1/btc/address/…` ($0.10 `labels`) — a
  miscategorized **Bitcoin** endpoint (hardcoded BTC address) that was payable
  but useless for our EVM/Base catalog and out-sorted the correct labeler on a
  `created_at` tie-break.

After cleanup, `labels` resolves to `x402.agentutility.ai/wallet-label` ($0.005),
with the free `eth-labels.com` registry alongside on every request.

## Notes / follow-ups

- No cassette re-record: the change is selection logic downstream of the HTTP
  calls (same URLs/methods/bodies); offline recipes are all ≤$0.012 so replay is
  byte-identical. 434 offline tests pass, replay 9/9, check + lint clean.
- The filter is generic to all categories, not just labels.
- `blocked` is operator-lift-only/terminal — if a blocked service's real price
  ever drops below the cap it won't auto-recover. Acceptable under the "keep the
  $0.10 cap" decision. If richer paid labels are wanted later, prefer a
  per-category cap override (env-configurable ceiling) over raising the global
  cap.
