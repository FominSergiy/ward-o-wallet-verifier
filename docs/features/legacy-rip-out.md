# legacy-rip-out

**What:** Removed all code paths that pre-dated the CDP discovery + rerank + invoke pipeline. The production surface is now just `/verify-agent`, `/discover`, and `/invoke` — no env-flag toggles, no stub-data DAG, no parallel implementations.

**Deletions:**
- Routes: `src/routes/verify.ts` (stub-DAG verify), `src/routes/plan.ts` (hardcoded DAG definition response), plus their tests
- Stub DAG: entire `src/dag/` tree (`runner.ts`, `types.ts`, `nodes/{preflight,sanctions,web_search,onchain,ens,synthesis}.ts`) — every node was a hardcoded `TODO: replace stub with real x402` returning canned data
- Legacy verify-agent branch: `verifyViaLegacy()` and its dependencies — `src/agent/{plan,resolve,phases,budgeted_call,merge,stop,synthesize}.ts` plus tests
- Env flag: `USE_DISCOVERY` and the `useDiscovery` opt — discovery is now the only mode
- Legacy types in `src/agent/types.ts`: `EarlyStop`, `Plan`, `Call`, `Receipt`, `AgentCtx`
- Legacy types in `src/dag/types.ts`: `DAGNode`, `PlanResponse`, `Signal`, `RiskReport`, `NodeResult`

**Files modified:**
- `src/agent/types.ts` — absorbed `ChainSchema`, `Chain`, `VerifyRequestSchema`, `VerifyRequest` from the deleted `src/dag/types.ts`; dropped legacy types
- `src/agent/verify.ts` — flattened to discovery-only (no `LegacyVerifyResult` union, no `shouldUseDiscovery` helper)
- `src/routes/verify_agent.ts` — dropped the `result.mode === "discovery"` branch and the `report/ctx` legacy fallthrough
- `src/main.ts` — unmounted `/plan` and `/verify`
- 8 files updated import paths from `"../dag/types.ts"` → `"./types.ts"` or `"../agent/types.ts"`
- `src/agent/verify_test.ts` — pruned the 2 legacy-routing tests; kept the synthesis-stub-verdict test
- `src/agent/llm_test.ts` — rewrote to use a local fixture schema instead of the deleted `PlanSchema`
- `src/agent/invoke_all_test.ts` — fixed the pre-existing viem-fallback leak (added `disableViemFallback: true`) and the pre-existing `no-unused-vars` warning

**Config:** None. `USE_DISCOVERY` env var is no longer read.

**Validation:**
- `deno task check`: clean
- `deno task lint`: dropped from 5 problems → **0** (4 `require-await` in deleted `budgeted_call_test.ts` + 1 `no-unused-vars` in `invoke_all_test.ts` both resolved)
- `deno task test`: **129 passed / 0 failed** (down from 170 — dropped ~41 legacy test cases)
- v5 e2e regression (Coinbase 1 + Garantex, matching v3) — see `docs/real-wallet-tests/report_v5.md`

**Notes:**
- The `/verify-agent` response shape is unchanged for existing clients — we only removed dead `mode`-discrimination code on the server side.
- `synthesize_verdict.ts` (the *discovery* verdict synthesizer) was preserved. The deleted `synthesize.ts` was the legacy `RiskReport`-shaped synthesizer.
