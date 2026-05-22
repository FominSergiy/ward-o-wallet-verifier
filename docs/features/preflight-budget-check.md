# preflight-budget-check

**What:** `/verify-agent` calls Agnic's free `/api/balance` endpoint before running the DAG; if `totalBalance` is below a configurable threshold, returns `HTTP 503 budget_exhausted` immediately. Prevents the v2-style mid-run cascade where calls would partially succeed before hitting `spending_limit_exceeded`.

**Files:**
- `src/discovery/network.ts` — new exported `fetchAgnicBudget()` (returns `AgnicBudget` with parsed numeric balances or null on key-missing / network error)
- `src/routes/verify_agent.ts` — refactored to expose `createVerifyAgentRouter(opts)` factory with a `budgetFetcher` test seam; default export `verifyAgentRouter` uses the real fetcher
- `src/routes/verify_agent_test.ts` — 3 new tests (503 below threshold; skip when fetcher returns null; do not block on fetcher failure)

**Config:**
- `AGNIC_BUDGET_MIN_USD` (env, optional) — threshold in USD. Defaults to `$0.10`. Set to `0` to disable.
- Reuses existing `AGNIC_API_KEY` for the balance call (free, no x402 spend).

**Notes:**
- Null result from `fetchAgnicBudget` (no key, fetch failure) is treated as "couldn't determine, proceed" — never blocks live traffic on the observability call.
- Bypasses the network-detection cache in `network.ts` (different freshness concern; balance can change every request).
- Threshold defaults to $0.10 — covers a single verification at typical spend ($0.015–$0.03) without gating normal traffic. Bump to $0.50 for more headroom across consecutive runs; bump to $10000 to test the 503 path manually.
