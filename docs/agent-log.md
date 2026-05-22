# Agent Log

Append-only. One row per completed feature, newest at bottom. Cross-reference slug with `docs/features/<slug>.md`.

| Date       | Slug          | Summary                                                                         |
|------------|---------------|---------------------------------------------------------------------------------|
| 2026-05-21 | x402-payments | agnicFetch x402 proxy client + x402Invoker replacing all stubs in budgetedCall |
| 2026-05-21 | service-discovery | CDP x402 discovery pipeline + LLM rerank + POST /discover route + e2e test     |
| 2026-05-22 | pattern-adapter-shape-trim | Trim alternateBodyShapes 5→1 to cut paid-call volume; v3 e2e validation 2/2 match, 0 rate-limit hits |
| 2026-05-22 | durable-health-filter | Persist lastErrorCode in health store; rank filters services flagged with payment_exceeds_max (durable catalog↔runtime price drift) |
| 2026-05-22 | preflight-budget-check | /verify-agent calls Agnic /api/balance before running the DAG; returns HTTP 503 budget_exhausted if totalBalance < AGNIC_BUDGET_MIN_USD (default $0.10) |
| 2026-05-22 | legacy-rip-out | Delete /verify + /plan routes, src/dag/** stub DAG, USE_DISCOVERY legacy branch and 7 dependent modules; relocate shared types to src/agent/types.ts |
