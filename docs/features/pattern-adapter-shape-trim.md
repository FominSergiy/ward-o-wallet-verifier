# pattern-adapter-shape-trim

**What:** Reduced `alternateBodyShapes` from 5 to 1 POST body variant so each paid upstream is attempted at most twice (primary + 1 fallback) before falling through to the LLM adapter — minimizing paid call volume against rate-limited and budget-capped upstreams.

**Files:**
- `src/discovery/adapter.ts` — `alternateBodyShapes()` now returns only `{ wallet, chain }`
- `src/discovery/adapter_test.ts` — updated `buildCallSetFromInfo` tests (expects `fallbacks.length === 1`; new dedupe test for primary-matches-only-alternate case)
- `docs/real-wallet-tests/report_v3.md` — new validation report (2-wallet run with Coinbase 1 + Garantex)
- `docs/real-wallet-tests/runs_v3/` — raw JSON artifacts

**Config:** None. No new env vars or external dependencies.

**Notes:**
- v3 e2e: 2/2 strict verdict match, both `high` confidence. LLM-adapter usage actually *dropped* 45% → 30% — trim did not hurt.
- Daily-limit triage: confirmed `spending_limit_exceeded` and "Too many requests from this IP" both come from Agnic gateway, not client-side inference. Resolved by user rotating to a higher-cap API key.
- Recurring hard error not fixed here: `orbisapi/wallet-cluster-score-api-32f2cb/bulk` always returns `Payment exceeds maximum allowed value` for the `labels` category. Treat as a follow-up — either rerank-time price filter or durable health-store signal for `payment_exceeds_max`.
- Other follow-ups in [report_v3.md](../real-wallet-tests/report_v3.md): pre-flight `creditBalance` check in `/verify-agent`, distinct outcome for `spending_limit_exceeded`, health-store rerank attribution log.
