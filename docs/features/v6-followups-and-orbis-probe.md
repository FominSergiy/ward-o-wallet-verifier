# v6-followups-and-orbis-probe

**What:** Closes three observability/safety follow-ups from
[report_v6_summary.md](../real-wallet-tests/report_v6_summary.md), adds a
dev-only LLM-adapter stress hook, and runs a paid probe of the orbisapi
label/reputation services to explain v6's "only API metadata" verdicts.

## Files

**Code:**
- [src/clients/agnic.ts](../../src/clients/agnic.ts) — `await resp.json()`
  replaced with `text()` + try/catch `JSON.parse`. On parse failure emits
  `AgnicFetchError` with `code: "non_json_response"`. HTTP status +
  truncated body preview included in the message.
- [src/agent/invoke_service.ts](../../src/agent/invoke_service.ts) —
  non-`AgnicFetchError` failures now propagate synthetic codes:
  `adapter_build_failed` (pattern-build throw),
  `adapter_llm_build_failed` (LLM call to build the request throws), and
  `adapter_call_failed` (LLM-built call throws a non-Agnic error). Also
  adds `FORCE_LLM_ADAPTER=true` dev-only env branch that skips Layer 1
  pattern adapter entirely; Layer 2 extracted into `invokeViaLlmOnly()`.
- [src/routes/verify_agent.ts](../../src/routes/verify_agent.ts) +
  [src/routes/verify_agent_stream.ts](../../src/routes/verify_agent_stream.ts) —
  expose `errorCode` field in the public receipts response.

**Tests:**
- [src/clients/agnic_test.ts](../../src/clients/agnic_test.ts) — added
  HTML response + empty body tests for `non_json_response` code.
- [src/agent/invoke_service_test.ts](../../src/agent/invoke_service_test.ts) —
  added 4 tests covering all 3 synthetic codes plus the
  `FORCE_LLM_ADAPTER=true` skip behavior.

**Throwaway script + docs:**
- [scripts/inspect_orbis_responses.ts](../../scripts/inspect_orbis_responses.ts) —
  hits the labels + reputation services on 3 known wallets, then probes
  the documented sub-endpoints (`/label`, `/score`), writes raw JSON +
  field inventories to a doc.
- [docs/real-wallet-tests/orbis_raw_responses.md](../real-wallet-tests/orbis_raw_responses.md) —
  output of the probe + analysis (~$0.053 spent).
- [docs/real-wallet-tests/report_v6_llm_stress.md](../real-wallet-tests/report_v6_llm_stress.md) —
  FORCE_LLM_ADAPTER stress run results across Vitalik + Lazarus wallets.

## Config

- New dev-only env var: `FORCE_LLM_ADAPTER=true` — skips the pattern
  adapter so every paid call goes through the LLM. Production traffic
  must leave this unset.
- No changes to `DURABLE_BLOCK_CODES` — the new synthetic codes
  (`non_json_response`, `adapter_*_failed`) are recorded for
  observability but do NOT auto-demote services. Future runs can decide
  to promote any of them to durable-block status once usage patterns
  emerge.

## Notes / gotchas

- **The big orbis finding:** the v6 verdicts that read "Label/Reputation
  provider returned only API metadata" were not Opus understating
  results — Opus was accurately reporting that the response IS the
  service-descriptor metadata. Pass-1 of the probe showed all 3 wallets
  got byte-identical responses on both services because the pattern
  adapter is hitting the catalog *root URL* (e.g.
  `https://orbisapi.com/proxy/crypto-address-labeler-api-79be80`) when
  the action endpoint is one level deeper (`/label`, `/score`). This is
  a real, fixable discovery-layer bug — full diagnosis + recommended
  fixes in [orbis_raw_responses.md](../real-wallet-tests/orbis_raw_responses.md)
  §Analysis.
- **LLM stress test result:** 8/8 services across 2 wallets ran via LLM,
  verdicts matched v6 baseline, **zero** validator URL rewrites. The
  validator is wired in and works in unit tests; this run shows the LLM
  doesn't actually drift on our current catalog so the validator sits
  dormant. Still a positive signal — means the LLM-built calls are
  catalog-compatible by default.
- **`adapter_call_failed` vs `adapter_llm_build_failed`:** subtle
  distinction worth keeping. `adapter_llm_build_failed` is the LLM API
  call to construct the request throwing; `adapter_call_failed` is the
  LLM-built request reaching agnic and the agnic call itself failing
  with a non-AgnicFetchError (transport-level). Together they cover
  every code path that previously left `lastErrorCode` undefined.

## Follow-ups created by this change

1. **Fix the pattern adapter's URL building for orbisapi-style services**
   that expose a discovery root + action sub-endpoints. See
   [orbis_raw_responses.md](../real-wallet-tests/orbis_raw_responses.md)
   §Analysis for two recommended approaches (read `inputInfo.pathParams`
   correctly OR add a service-descriptor-detection heuristic).
2. **Find providers that actually populate `known_label` for famous
   addresses** — the orbisapi labels service returns `is_known: false`
   for Vitalik, Binance HW20, and Lazarus, which is a real coverage
   gap. Either find better catalog entries or accept that labels stays
   informational-only on this catalog.
3. The `/score` sub-endpoint on the reputation service returns
   `unauthorized` through the agnic gateway — separate auth/paywall
   layer the $0.0075 catalog price doesn't unlock. Investigate
   whether agnic supports passing additional credentials, or skip this
   service entirely.
