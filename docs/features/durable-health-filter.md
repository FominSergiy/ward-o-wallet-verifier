# durable-health-filter

**What:** Persist the Agnic error code (`lastErrorCode`) on each recorded failure and have the ranker skip services flagged with `payment_exceeds_max`. Fixes a recurring hard error from `orbisapi/wallet-cluster-score-api-32f2cb/bulk` where the CDP catalog advertises $0.001 but the runtime x402 challenge demands more.

**Files:**
- `src/discovery/health_store.ts` — `ServiceHealth.lastErrorCode`, `recordError(resource, msg, code?)`, new `isDurablyBlocked()`
- `src/discovery/health_store_test.ts` — 3 new tests (lastErrorCode persists; isDurablyBlocked positive + negative cases)
- `src/discovery/rank.ts` — new `filterDurablyBlocked()` runs before rerank; re-includes blocked entries if the filter would empty a category
- `src/discovery/rank_test.ts` — 2 new tests (filter excludes blocked candidates; re-inclusion safety net)
- `src/agent/invoke_service.ts` — `ServiceInvocationOutcome.errorCode` (populated from `AgnicFetchError.code`)
- `src/agent/invoke_all.ts` — `recordError(..., outcome.errorCode)` propagates the code into the health store

**Config:** None. Filtering is automatic once the health store records a `payment_exceeds_max`. The store path is still controlled by `HEALTH_STORE_PATH` (default `data/service_health.json`).

**Notes:**
- Durable-block code set lives at the top of `health_store.ts` (`DURABLE_BLOCK_CODES`). To extend: add new x402 error codes that signal a service-specific (not global) failure pattern.
- Reset behavior: delete the health-store file (or call `_resetHealthStoreForTests()` in tests). A blocked service is otherwise blocked indefinitely.
- Won't help against transient throttling (`rate_limited`, `upstream_429*`) or global state (`insufficient_balance`, `no_wallet`) — by design.
