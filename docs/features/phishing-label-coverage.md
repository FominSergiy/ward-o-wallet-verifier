# phishing-label-coverage

## What

Closes a verdict-correctness gap discovered against `0xfb6E71e0800BcCC0db8a9Cf326fe3213CA1A0EA0`, which Etherscan tags `Fake_Phishing201479` (GoPlus-reported) but our verifier was marking `safe_to_transact`. The fix has two parts:

1. **Broader labels discovery** — the `labels` category now issues two Bazaar catalog queries per verification: the original CEX/attribution query and a new phishing/scam blocklist query. Results from both queries are unioned and de-duplicated by `resource` URL before ranking, so the LLM ranker now has both signal families in its candidate pool.
2. **Stricter verdict policy** — `safe_to_transact` requires a **Positive Identity Confirmation (POIC)**: a positive `labels` finding (exchange/verified/protocol/dao/foundation/known_safe/attestation), a confirmed ENS reverse-resolution, or a clean contract identification. A non-zero balance or long tx history is no longer treated as a positive signal. When sanctions are clean but no POIC exists, the verdict is `insufficient_data` with `confidence="low"` rather than an over-confident `safe_to_transact`.

## Files

- `src/discovery/queries.ts` — `CATEGORY_QUERIES` and `queriesForCategories` now return `string[]` per category. `labels` gets two queries.
- `src/discovery/orchestrator.ts` — `fetchCandidates` flattens `(category, query)` pairs, fans out in parallel, then unions+dedupes by `resource`. Error reporting tracks per-query failures so a category is only marked errored if every sub-query failed.
- `src/discovery/queries_test.ts` — updated existing tests for the array signature; added a new test asserting `labels` emits both an attribution-shaped and a phishing/scam-shaped query.
- `src/discovery/orchestrator_test.ts` — updated partial-results test for multi-query labels; added union/dedupe and partial-success tests.
- `src/agent/synthesize_verdict.ts` — rewrote the `labels` weighting block, added a new **Positive identity confirmation** block, and rewrote the **Verdict mapping** block so `safe_to_transact` requires a POIC and `insufficient_data` is the default when POIC is absent.
- `src/agent/synthesize_verdict_test.ts` — added a prompt-content assertion verifying the POIC text and hard ban on safe-without-POIC are present.
- `scripts/e2e_verify.ts` (new) — runs the 4-wallet reference set against `/verify-agent` and prints PASS/FAIL.
- `deno.json` — added `verify:e2e` task.

## Config

None. No new env vars or external SDKs; all signal lookups still flow through existing x402/Agnic plumbing.

## E2E validation result

```
~/.deno/bin/deno task dev          # PORT=8101 in test run
VERIFY_BASE_URL=http://localhost:8101 ~/.deno/bin/deno task verify:e2e
```

| Wallet | Etherscan ground truth | Verdict | Confidence | Result |
|--------|------------------------|---------|------------|--------|
| `0x098B...2f96` (Ronin Bridge Exploiter, Lazarus) | OFAC-Sanctioned, USDC/USDT blocked | `do_not_transact` | `high` | ✓ sanctions regression guard holds |
| `0xfb6E...0EA0` (Fake_Phishing201479) | Phish/Hack, reported by GoPlus | `insufficient_data` (safe=false) | `low` | ✓ original bug fixed (was `safe_to_transact`) |
| `0xF977...aceC` (Binance Hot Wallet 20) | Labeled CEX, clean | `insufficient_data` (safe=false) | `low` | ✓ false-positive guard holds (did not flag dangerous) |
| `0xd8dA...6045` (vitalik.eth) | Doxxed ENS, clean | `insufficient_data` (safe=false) | `low` | ✓ false-positive guard holds (did not flag dangerous) |

4/4 pass.

## Notes

- **The phishing wallet now correctly returns `insufficient_data`, not `safe_to_transact`** — even before any new phishing-DB service appears in the Bazaar catalog, the tightened verdict policy alone is sufficient to stop us from incorrectly green-lighting unlabeled phishing addresses. If a GoPlus/Chainabuse-style service does surface (and the broader discovery query now lets the ranker pick it), the verdict can sharpen to `do_not_transact`.
- **Binance and vitalik.eth land on `insufficient_data` rather than `safe_to_transact`** — this is the honest answer given the current Bazaar label inventory (the picked label provider returned empty for both). It is NOT a verdict bug; it's the new policy correctly refusing to vouch for safety without a POIC. Reaching `safe_to_transact` for these requires either a richer label provider in the catalog or wiring ENS reverse-resolution into `DEFAULT_CATEGORIES`.
- **Follow-up worth tracking**: add `ens` to `DEFAULT_CATEGORIES` in `src/agent/verify.ts` and implement a free viem-based ENS reverse-resolution provider so doxxed wallets get their POIC without depending on Bazaar inventory. The verdict policy is already ready for it.
- **No new caching or rate-limit work needed** — the second labels query reuses the same `searchDiscovery` client, runs in parallel with the first, and de-duplication by `resource` URL means the ranker never sees doubled candidates.
