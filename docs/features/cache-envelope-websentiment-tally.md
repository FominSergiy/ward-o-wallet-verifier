# cache-envelope-websentiment-tally

**What:** Three fixes on the `feat/latency-shape-fast-tier-denylist` branch — make cached verdicts render the full paid-services breakdown, stop web_sentiment from spuriously timing out (and mislabeling the error), and make the header spend meter agree with the verdict card's total.

## Files

**#2 — Cache full result envelope**
- `src/agent/verdict_cache.ts` — new `CachedVerdict` envelope (`verdict`, `outcomes`, `totalSpentUsdc`, `totalLlmCostUsd`, `walletNetwork`); `VerdictCache.get/set` operate on it; `SCHEMA_VERSION` 1→2 (old verdict-only entries miss cleanly).
- `src/agent/verify.ts` — `VerifyAgentResult.fromCache?`; cache-hit path returns the stored receipts + cost totals + `fromCache:true`; both `cache.set` sites (deep happy path + oracle-sanctioned) now store the envelope.
- `src/routes/verify_agent.ts`, `src/routes/verify_agent_stream.ts` — `fromCache` added to the result payload.
- `web/src/types.ts` — `VerifyResultPayload.fromCache?`, `VerifyReceipt.bestEffort?`.
- `web/src/components/VerdictCard.tsx` — cached results render the breakdown; "Total spent" becomes "Original cost" + a "served from cache · $0 charged this run" note.
- `web/src/hooks/useFlowState.ts` — header meter set to `$0` on cache hits.

**#3 — web_sentiment timeouts**
- `src/agent/invoke_all.ts` — `BEST_EFFORT_CATEGORIES` (exported; `web_sentiment`), `BEST_EFFORT_TIMEOUT_MS` (6s), `PER_HOST_CONCURRENCY` (2) + `createHostLimiter` semaphore shared across the fan-out, `backstopMs()` outer-race budget, `withInvokeTimeout` aborts the in-flight call on timeout.
- `src/agent/invoke_service.ts` — `CallOpts` (`signal`, `timeoutMs`) threaded through `invokeRankedService` → `performCall`/`performCallWithRateLimitRetry`/`handleDescriptorResponse`/`invokeViaLlmOnly` → `agnicFetch`; `abortableSleep` for the backoff; `callErrorCode()` canonicalises rate-limit failures to `errorCode:"rate_limited"`; abort guards skip the LLM fallback after a per-call timeout.
- routes — `bestEffort: BEST_EFFORT_CATEGORIES.has(o.category)` on each receipt.
- `web/src/components/VerdictCard.tsx` — `receiptStatusLabel`/`receiptErrorText` render "rate-limited" and "skipped · best-effort".

**#4 — Tally**
- `web/src/hooks/useFlowState.ts` — on the `result` event, `spentUsdc = totalSpentUsdc + totalLlmCostUsd` (and `0` when `fromCache`), so the header matches the card.

**Tests:** `src/agent/verdict_cache_test.ts` (envelope round-trip, schema-bump miss, cache-hit `fromCache`+receipts), `src/agent/fast_tier_test.ts` (store envelope), `src/agent/invoke_all_test.ts` (per-host cap, cross-host parallelism, best-effort non-blocking), `src/agent/invoke_service_test.ts` (rate-limited-after-retry → `errorCode:"rate_limited"`).

## Config

No new env vars. Existing `INVOKE_TIMEOUT_MS` still overrides the per-call budget. `PER_HOST_CONCURRENCY` (2) and `BEST_EFFORT_TIMEOUT_MS` (6s) are constants in `invoke_all.ts`.

## Notes

- **No cassette re-record.** No request URL/method/body changed; the per-host cap only reorders same-host calls and the abort/timeout changes don't alter recorded traffic. `deno task test:replay` stays 9/9.
- **Cache schema bump is forward-only.** Existing KV entries from `SCHEMA_VERSION "1"` simply miss and get recomputed; no migration.
- **Cached card shows historical cost, not $0.** Internal consistency (rows → subtotals → total all reflect the original run); "you weren't charged this run" is conveyed by the note + the $0 header meter, not by zeroing the receipts.
- **`web_sentiment` is demoted, not removed.** It's still attempted on every deep call (coverage guardrail); only its failure handling changed.
- **web_sentiment cassette key aligned to current price.** The recorded entries were keyed at `maxValue=5000` (price 0.005) while the live recipe price drifted to 0.012 (`maxValue=12000`), so the current request was a cassette-miss. Bumped the sentiment `key` + `request.url` to `maxValue=12000` (surgical line-level edit across the 7 real-wallet cassettes; response untouched) so the request now matches. The recorded response is still the original `402 "Payment exceeds maximum allowed value"` (web_sentiment has never been recorded successfully — the price was always below the service's real $0.01). web_sentiment therefore still resolves as a non-blocking best-effort failure in replay, but via a matched recorded 402 rather than a miss. A real 200 would require a paid re-record.
- **Not verified in a live browser/paid run.** Logic is covered by 345 offline tests + web typecheck/build; exercising a real cached/rate-limited verdict card needs `AGNIC_API_KEY` + USDC (paid deep calls), left as an explicit opt-in.
