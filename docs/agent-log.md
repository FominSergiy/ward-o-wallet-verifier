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
| 2026-05-23 | verify-agent-stream | Add VerifyEvent union + thread optional onEvent through verifyAgent / invokeAll / discover; POST /verify-agent-stream SSE route mirroring /verify-agent error mapping. Backend half of the demo-ui plan. |
| 2026-05-23 | demo-ui | Vite+React single-page demo under web/: Logo / InputForm / PlanCard (saved to localStorage) / LogStream (SSE) / VerdictCard. E2E verified in browser against vitalik.eth — Plan → Save → reload-restore → Execute → live phase/service events → "safe to transact" verdict. |
| 2026-05-23 | discover-stream | POST /discover-stream SSE route + two-tab terminal UI. Frontend Plan now streams discover events (phase/log/plan) into a "plan" tab, Execute into an "execute" tab — both preserved, click to flip without re-running. PlanEvent gained optional `unresolvedCategories`; api.ts extracted a generic `consumeSSE` helper. |
| 2026-05-23 | discovery-quality-and-not-found-fix | Refine labels/web_sentiment/contract_analysis CDP queries; EOA short-circuit drops contract_analysis when address has no bytecode (new `coverage.not_applicable` bucket); constrain LLM-fallback adapter to catalog URL path (validator + rewrite); normalize agnic error codes to snake_case and add `not_found` to durable-block codes. v6 e2e: 12/12 verdicts correct across 3 runs × 4 wallets, 0 `Not found` errors (v5 baseline: 30%). |
| 2026-05-23 | flow-viz | Pure-SVG flow diagram view on Execute tab — visualizes verify-agent fanout into categories → x402 payment diamonds → fallback diamonds (on primary error) → synthesize → verdict, derived from `VerifyEvent[]` via a `useFlowState` hook. Toggle (`logs ⇄ flow`) in the existing tab strip. |
| 2026-05-23 | v6-followups-and-orbis-probe | Wrap agnicFetch json-parse in try/catch (synthetic `non_json_response` code); add adapter_build_failed / adapter_call_failed / adapter_llm_build_failed codes; surface errorCode in route receipts; add dev-only FORCE_LLM_ADAPTER=true env flag + 2-wallet stress run (LLM path 8/8, 0 validator rewrites, verdicts still correct). Orbis probe revealed labels/reputation services were returning service-descriptor blobs, not address data — the pattern adapter is hitting the root URL when real data lives at `/label` and `/score` sub-paths. |
