# reliability-tighten-hotpath

**What:** Stops the registry hot path from deterministically selecting dead
upstream services by fixing the inverted scoring/selection, hardening the free
viem onchain fallback, fast-failing structurally-dead endpoints, and keeping
discovery from seeding junk.

## Problem (grounded in prod DB `super-grass-68246474`)

`labels`, `onchain_history`, `web_sentiment` had **0 active** services — selection
fell to `probation`, where the *inversion* lived: proven 53%-ok services were
`blocked` while 0%-ok ones sat at `score 1.0` and won the primary slot. Root
causes: (1) `computeScore` returned `1.0` for zero observations, so an untested
candidate tied/outranked a proven one; (2) payer-side `payment_exceeds_*` errors
were counted as reliability failures and permanently blocked working services;
(3) the free viem fallback used a single dead RPC (`cloudflare-eth.com`, 0/12
success); (4) structurally-dead endpoints were re-probed (6–9s) every request;
(5) discovery seeded `openapi.json` / `:endpoint` / `info` meta-URLs as
selectable rows.

## Changes

- **`src/registry/score.ts`** — pessimistic Bayesian smoothing
  (`smoothedReliability`, prior 1/4) so zero/low-observation services score low
  (not 1.0); `WindowMetrics.excluded` + a SQL `FILTER` exclude payer-side
  failures (`payment exceeds maximum`, `insufficient balance`, `no wallet`) from
  the reliability denominator; `MIN_BLOCK_OBSERVATIONS` guard stops a tiny
  all-failure sample from permanently blocking.
- **`src/registry/block.ts`** (new) — `blockDeadServiceIfStructural`: fire-and-
  forget `service_registry` block on structural error codes
  (`DOMAIN_DEAD_CODES`: not-x402, 404, unsubstituted-path, descriptor-only) so
  the next request's selection skips them. No-op offline; excludes transient
  (`timeout`/`rate_limited`/`non_json_response`) and payer-side codes. Wired into
  `src/agent/invoke_all.ts` at the error path.
- **`src/agent/onchain_viem.ts`** — multi-RPC `fallback` transport with healthy
  public defaults per chain + per-chain env override (single URL or
  comma-separated). `rpcUrlsForChain` is exported/tested.
- **`src/vetter/run.ts`** — new candidates insert at `UNPROVEN_INSERT_SCORE`
  (0.25), not 1.0; `isLikelyInvokableEndpoint` filters descriptor/meta-URLs out
  of discovery before insert.

## Files

- Added: `src/registry/block.ts`, `src/registry/block_test.ts`,
  `docs/features/reliability-tighten-hotpath.md`
- Changed: `src/registry/score.ts` (+ `score_test.ts`), `src/vetter/run.ts`
  (+ `run_test.ts`), `src/agent/onchain_viem.ts` (+ `onchain_viem_test.ts`),
  `src/agent/invoke_all.ts`, `src/agent/invoke_service.ts` (comment only)

## Config

- Optional prod env (recommended): `RPC_URL_ETH`, `RPC_URL_BASE`, … — single URL
  or comma-separated list; overrides the public-RPC defaults for the viem
  onchain fallback. No new required env.

## Notes / follow-ups

- **Deferred (needs `cassette:record`):** fixing `HARD_ERROR_CODES` to include
  the real normalized `payment_exceeds_maximum_allowed_value` (the
  `payment_exceeds_max` literal never matches it, so a cap error wastefully
  triggers an LLM fallback). The fix changes the replay call sequence — a
  recorded cap error currently triggers that fallback — so it requires a paid
  re-record. Documented in-code at `invoke_service.ts`.
- **Deferred:** running the scorer more frequently / online scoring so dead
  discoveries don't serve traffic for a full batch window.
- **One-time prod DB stopgap** (operator-run, with approval): un-block the proven
  53%-ok services to `active` and block the 0%-ok probation junk — restores a
  proven primary in `labels`/`onchain_history` immediately, before deploy.
- Replay stays 9/9 (no request-shape change); 382 offline tests pass; lint +
  `deno task check` clean.
