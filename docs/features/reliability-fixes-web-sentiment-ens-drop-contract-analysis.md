# reliability-fixes-web-sentiment-ens-drop-contract-analysis

## What

Five reliability fixes triggered by real-wallet runs where the v8 mock-driven regression had been masking live-catalog problems:

1. **Drop `contract_analysis` category** entirely. It was always EOA-skipped via `CONTRACT_ONLY_CATEGORIES`, and for real contracts the CDP Bazaar carried no matching provider, so the category was permanently dead.
2. **Strict URL placeholder validator.** A new `assertNoUnsubstitutedPlaceholders(url)` helper in the pattern adapter rejects any URL whose pathname still contains a `:identifier` token after substitution. Caught the Orbis `…wallet-address-risk-api-c6680c/:endpoint` and `…onchain-news-api-591f86/:endpoint` variants pre-call, so the call never goes out as an HTML 404. AdapterFailedError surfaces with `errorCode: "unsubstituted_path_param"`.
3. **Expanded durable health filter** — `unsubstituted_path_param`, `descriptor_only_response`, `non_json_response` now join `payment_exceeds_max` / `not_found` as one-strike durable block codes. The empty-category safety net in `rank.ts` still re-includes if all candidates would be blocked.
4. **ENS streaming visibility.** Service `ok`/`error` events now include `durationMs`; a `log` event always fires with the concrete outcome (`ens_resolve: 0x… → vitalik.eth` or `ens_resolve: 0x… → no_primary_name`); LogStream renders `kind: "direct"` ok events as `· resolved · {ms}` instead of the misleading `· paid $0.0000 · ?ms`.
5. **Reduce Orbis monoculture.** Tightened `web_sentiment` and `onchain_history` discovery queries to push the ranker away from risk-scoring and balance-only endpoints. Added per-host coverage tracking so candidates whose host already appears in another category get a `[hint: host X also appears in candidates for: ...]` annotation, and added a SOFT Rule 7 to the ranker prompt directing the LLM to prefer host diversity on ties.

## Files

**Backend**

- `src/agent/types.ts` — Category union shrunk to 5 entries (sanctions, labels, onchain_history, web_sentiment, ens)
- `src/agent/verify.ts` — removed `CONTRACT_ONLY_CATEGORIES`, `isContract` hook, and the EOA-skip block; ENS `resolveEnsWithEvents` now stamps `durationMs` on ok/error and emits a deterministic `ens_resolve:` log line
- `src/agent/onchain_viem.ts` — docstring on `isContract` updated (function kept as a chain primitive)
- `src/agent/verdict.ts` — `not_applicable` docstring no longer pins `contract_analysis` as the example
- `src/agent/synthesize_verdict.ts` — removed the "5. contract_analysis — CONDITIONAL" prompt block; renumbered ENS to 5
- `src/agent/invoke_service.ts` — imports + invokes `assertNoUnsubstitutedPlaceholders`; pattern + LLM-fallback catches map `AdapterFailedError(reason ~ "unsubstituted_path_param")` to `errorCode: "unsubstituted_path_param"`; descriptor sub-path retry now validates the rejoined URL
- `src/discovery/adapter.ts` — new exported `assertNoUnsubstitutedPlaceholders` helper + `UNSUBSTITUTED_PLACEHOLDER_RE`; validation calls inserted in `buildCallFromInfo` (no-info, GET, POST branches) and `buildCallFromInfoViaLlm` (both the path-validator-rewrite branch and the pass-through return)
- `src/discovery/health_store.ts` — `DURABLE_BLOCK_CODES` now includes `unsubstituted_path_param`, `descriptor_only_response`, `non_json_response`
- `src/discovery/queries.ts` — removed `contract_analysis`; tightened `web_sentiment` and `onchain_history` query strings
- `src/discovery/rank.ts` — new `hostOf` / `buildHostCoverage` helpers; per-entry `[hint: host ...]` annotation and Rule 7 in the rerank prompt
- `src/routes/discover.ts` / `src/routes/discover_stream.ts` / `src/routes/invoke.ts` — `contract_analysis` removed from `DEFAULT_CATEGORIES`

**Tests** (all passing, 250 total)

- `src/discovery/adapter_test.ts` — 9 new cases covering `assertNoUnsubstitutedPlaceholders`, `buildCallFromInfo` rejecting unsubstituted tokens, port handling, mid-segment `:` ignored
- `src/discovery/health_store_test.ts` — 3 new cases asserting one-strike durable block for each new code
- `src/discovery/rank_test.ts` — 2 new cases for host-diversity hint emission and absence
- `src/agent/verify_test.ts` — replaced two EOA-skip tests with a regression that asserts `contract_analysis` never appears in plan / discovery / coverage; added 2 ENS tests asserting `service:ok` carries `durationMs` and a `log` event with the concrete `ens_resolve: ...` message fires (resolved + no_primary_name + RPC-error branches)
- Various test fixtures updated to drop `contract_analysis` from category lists

**Frontend**

- `web/src/types.ts` — Category union shrunk
- `web/src/categoryLabels.ts` — entry removed
- `web/src/components/FlowDiagram.tsx` — `CATEGORY_LABELS` entry removed
- `web/src/components/LogStream.tsx` — direct service events render `· free` on start and `· resolved · {ms}` on ok

## Config

No new env vars. No new external deps. Existing `data/service_health.json` will accumulate `unsubstituted_path_param` entries for any broken catalog URL on first encounter; on Deno Deploy the equivalent lives in memory only and resets per cold start.

## Notes

- **Live E2E verified** against `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`: the rerank picked `onchain-news-api-591f86/:endpoint` as the `web_sentiment` primary, the validator rejected it pre-call with `unsubstituted_path_param: :endpoint`, the same-run alternate-rescue tried `wallet-address-risk-api-c6680c` and succeeded ($0.0010 · 7s), verdict came back `safe_to_transact` high confidence at $0.0109 total spend. The bad URL's lastErrorCode is now durably recorded — next run will filter it out of the candidate pool before the LLM even sees it.
- **Same-run fallback math:** `MAX_ALTERNATES_PER_CATEGORY = 2` in `invoke_all.ts` is unchanged. The strict validator just makes the *primary* fail synchronously instead of after a 60s timeout / HTML response, freeing the alternate budget for genuine retries.
- **Host-diversity hint is a soft signal** — the rerank prompt explicitly says it never overrides failure-rate / quality / completeness. A monoculture is still possible if Orbis is genuinely the only well-documented provider in a category.
- **`isContract` was kept** in `src/agent/onchain_viem.ts` as a chain primitive. It is no longer wired into `verifyAgent` but the helper is general-purpose and exported.
- **Follow-up:** the `onchain_history` Orbis pick (`wallet-api-5f3267/balance/:address`) still returns balance-only, not transaction history. The query tightening + diversity bias should help but won't change behavior until the next CDP Bazaar refresh surfaces a more apt provider. Worth re-checking after a week.
