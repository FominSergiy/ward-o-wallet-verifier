# discovery-quality-and-not-found-fix

**What:** Improves the data quality of three discovery categories
(`labels`, `web_sentiment`, `contract_analysis`) and eliminates the
`agnicFetch [Not found]: Not Found` error class that v5 runs were hitting on
the LLM-fallback adapter path.

**Files:**

- `src/discovery/queries.ts` — refined query strings for labels /
  web_sentiment / contract_analysis.
- `src/agent/onchain_viem.ts` — new `isContract(address, chain)` helper
  (`getCode` via viem, fail-closed to `false`).
- `src/agent/verify.ts` — EOA short-circuit drops contract_analysis when the
  address has no bytecode; tracks dropped categories in a new
  `coverage.not_applicable` bucket.
- `src/agent/verdict.ts` — `CoverageSchema` gained optional
  `not_applicable: Category[]`.
- `src/agent/synthesize_verdict.ts` — prompt instructs the synthesizer to
  treat `not_applicable` categories as N/A, not as coverage gaps.
- `src/discovery/adapter.ts` — LLM-fallback prompt locked to the catalog
  URL path; structural post-LLM validator rewrites mangled URLs back to the
  catalog URL while preserving the LLM-built body/method. Logs
  `[adapter-llm] url-changed: ...` on each rewrite.
- `src/clients/agnic.ts` — error code from agnic responses is normalized to
  snake_case (`"Not found"` → `"not_found"`) so the durable-block matcher
  can use it.
- `src/discovery/health_store.ts` — added `"not_found"` to
  `DURABLE_BLOCK_CODES` so a service returning 404 once is demoted by the
  ranker on subsequent runs.
- `web/src/types.ts` — `Coverage` mirrors the backend's optional
  `not_applicable` field.
- `scripts/test_wallets.ts` — trimmed to a 4-wallet validation panel
  (Vitalik, Binance HW20, Lazarus, Tornado Cash).
- Tests updated/added: `queries_test.ts`, `adapter_test.ts` (2 new tests for
  the URL validator), `agnic_test.ts` (404 normalization),
  `health_store_test.ts` (not_found durable-block), `verify_test.ts` (EOA
  skip).

**Config:** No new env vars. `isContract` uses the existing
`RPC_URL_ETH/BASE/...` env vars for chain RPC endpoints.

**Validation:** `docs/real-wallet-tests/report_v6_summary.md` covers 3 runs
× 4 wallets:

- 12/12 verdicts correct (v5 baseline: 1/2 strict match).
- 0/48 hard errors (v5: 50%).
- 0/48 `Not found` errors (v5: 30%).
- 0/48 LLM-fallback-adapter invocations — the refined queries surfaced
  pattern-adapter-friendly services, so the new LLM validator never had to
  fire in production traffic (it has unit-test coverage).

**Notes / known gaps:**

- Cloudflare-eth's `eth_getCode` is flaky (returns `-32603 Internal error`
  intermittently); the helper fail-closes to "EOA" which is conservative
  (we skip a potentially-wasted paid call) but means a true contract may be
  mislabeled. v6 hit this on the Tornado Cash router and the verdict was
  still correct from sanctions+labels signal. Follow-up: add RPC failover
  or allow `RPC_URL_ETH` to point at a paid endpoint.
- `agnicFetch` calls `resp.json()` unconditionally — if upstream returns an
  HTML error page (as happened once with an orbisapi `:endpoint`
  placeholder URL), the JSON parse throws *before* an `AgnicFetchError` can
  be constructed, so the failure is recorded in the health store without a
  `lastErrorCode` and therefore not durably blocked. Follow-up: wrap the
  parse and synthesize a `code: "non_json_response"` on failure.
- B2 (LLM-adapter URL validator) is in place but was not exercised by
  production traffic in the v6 validation runs.
