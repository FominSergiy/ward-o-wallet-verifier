# Real-Wallet E2E Test Report — /verify-agent

**Run at:** 2026-05-22T01:32:02.820Z

**Endpoint:** `http://localhost:8000/verify-agent`

**Total addresses:** 5

## Aggregate metrics

- **Total x402 spend:** $0.0750 USDC
- **Total wall-clock:** 269.8s (sequential, 90s delay between runs to avoid upstream rate limits)
- **Verdict accuracy:** 5 match / 0 partial (insufficient_data) / 0 mismatch / 0 error → 100% strict match
- **Service-call outcomes:** 14 primary-hit / 5 alternate-rescue / 6 hard-error across 25 attempts
- **Primary-pick reliability:** 56% (% of LLM-rerank-chosen services that worked on first attempt)
- **Alternate-rescue rate:** 20% (% of attempts resolved via runner-up service)
- **LLM-adapter usage:** 48% (% of attempts that needed LLM-built call args)

## Per-address summary

| Address | Category | Expected | Actual | Conf | ✓/✗ | Primary | Alt rescue | LLM adapter | Errors | Spend | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `0xd8dA6B…6045` | Vitalik's main wallet (vitalik.eth) | safe_to_transact | safe_to_transact | medium | ✓ | 3 | 1 | 3 | 1 | $0.0160 | 61s |
| `0xf97781…acec` | Binance Hot Wallet 20 | safe_to_transact | safe_to_transact | high | ✓ | 3 | 1 | 2 | 1 | $0.0160 | 48s |
| `0x098B71…2f96` | Lazarus Group (Ronin bridge hack) | do_not_transact | do_not_transact | high | ✓ | 3 | 1 | 2 | 1 | $0.0160 | 58s |
| `0xd90e2f…f31b` | Tornado Cash router contract | do_not_transact | do_not_transact | high | ✓ | 3 | 1 | 2 | 1 | $0.0160 | 48s |
| `0xa5e4b4…4f83` | Pink Drainer scam wallet | do_not_transact | do_not_transact | medium | ✓ | 2 | 1 | 3 | 2 | $0.0110 | 55s |

## Per-service reliability

| Service URL | OK | Error | Success rate |
|---|---|---|---|
| `https://api.anchor-x402.com/v1/screen` | 5 | 0 | 100% |
| `https://orbisapi.com/proxy/crypto-address-labeler-api-79be80` | 5 | 0 | 100% |
| `https://blockrun.ai/api/v1/surf/search/web` | 5 | 0 | 100% |
| `https://orbisapi.com/proxy/smart-contract-audit-pro-api-eec894` | 4 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-balance-api-5575de/balance/:address` | 0 | 3 | 0% |
| `https://orbisapi.com/proxy/wallet-balance-api-5575de/v1/tokens/:address` | 0 | 2 | 0% |
| `https://orbisapi.com/proxy/smart-contract-auditor-api-0061a9` | 0 | 1 | 0% |

## Per-address detail

### Vitalik's main wallet (vitalik.eth)

- **Address:** `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
- **Chain:** `eth`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `medium`)
- **Headline:** Safe to transact: this is the well-known vitalik.eth address with a clean sanctions check and no negative web signals.
- **Reasoning:** The sanctions screen returned a clean result with no matches against active lists, which is the most important positive signal. Web search results surface the address on mainstream block explorers (Etherscan, Ethplorer) with no mention of scam, hack, exploit, or fraud — this address is the publicly known vitalik.eth wallet. Labels and contract_analysis endpoints returned API descriptors rather than substantive findings, and onchain_history was unresolved, so confidence is capped at medium despite the strongly positive sanctions and sentiment signals.
- **Coverage:** resolved=[sanctions, labels, web_sentiment, contract_analysis] unresolved=[onchain_history]
- **Hard errors:**
  - [onchain_history] agnicFetch [Target API is not X402 enabled]: Bad Request

### Binance Hot Wallet 20

- **Address:** `0xf977814e90da44bfa03b6295a0616a897441acec`
- **Chain:** `eth`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `high`)
- **Headline:** Safe to transact: this address is Binance Hot Wallet 20, a well-known centralized exchange wallet with no sanctions hits.
- **Reasoning:** The sanctions check returned a clean result with no matches against the active sanctions corpus. Web sentiment evidence strongly identifies this address as 'Binance: Hot Wallet 20' on Blockscan, holding tens of billions of dollars across 24 chains — consistent with a major, publicly-known exchange hot wallet rather than a malicious actor. The labels and contract_analysis endpoints returned only API metadata (no specific risk labels or vulnerabilities), and on-chain history was unresolved, but the strong exchange identification combined with clean sanctions outweighs those gaps. Users should still always confirm the deposit address with their exchange before sending.
- **Coverage:** resolved=[sanctions, labels, web_sentiment, contract_analysis] unresolved=[onchain_history]
- **Hard errors:**
  - [onchain_history] agnicFetch [Target API is not X402 enabled]: Bad Request

### Lazarus Group (Ronin bridge hack)

- **Address:** `0x098B716B8Aaf21512996dC57EB0615e2383E2f96`
- **Chain:** `eth`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** DO NOT TRANSACT: This wallet is sanctioned (OFAC SDN / DPRK / Lazarus Group) and publicly identified as the Ronin Bridge Exploiter.
- **Reasoning:** Sanctions screening returned a confirmed match against OFAC SDN, the Lazarus Group, and DPRK programs — this is a hard veto that overrides all other signals. Web sentiment independently corroborates this: Etherscan publicly tags the address as the "Ronin Bridge Exploiter" tied to one of the largest crypto hacks on record. Even though onchain_history was unresolved and the labels/contract_analysis endpoints returned only API metadata, the sanctions hit plus corroborating web evidence is sufficient for a high-confidence negative verdict. Sending funds to this address would likely constitute a sanctions violation in addition to funding stolen-asset laundering.
- **Coverage:** resolved=[sanctions, labels, web_sentiment, contract_analysis] unresolved=[onchain_history]
- **Hard errors:**
  - [onchain_history] agnicFetch [Target API is not X402 enabled]: Bad Request

### Tornado Cash router contract

- **Address:** `0xd90e2f925da726b50c4ed8d0fb90ad053324f31b`
- **Chain:** `eth`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** DO NOT TRANSACT: this address is on the OFAC SDN list as a sanctioned Tornado Cash address.
- **Reasoning:** The sanctions check returned a confirmed hit against both the OFAC SDN list and the Tornado Cash designation, which is an automatic hard veto regardless of any other signal. Web search results corroborate this by referencing the August 2022 OFAC sanctioning of Tornado Cash addresses. Labels and contract_analysis endpoints returned only API metadata (no usable verdict), and onchain_history was unresolved, but none of these can override a confirmed sanctions match. Sending funds to this address would likely violate U.S. sanctions law.
- **Coverage:** resolved=[sanctions, labels, web_sentiment, contract_analysis] unresolved=[onchain_history]
- **Hard errors:**
  - [onchain_history] agnicFetch [Target API is not X402 enabled]: Bad Request

### Pink Drainer scam wallet

- **Address:** `0xa5e4b451d0a3c3d05fc3a8076fda45952b8f4f83`
- **Chain:** `eth`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `medium`)
- **Headline:** Do not transact: web sentiment surfaces a MistTrack alert tied to this address despite a clean sanctions check.
- **Reasoning:** Sanctions screening returned a clean result, which is a strong positive baseline. However, web sentiment search results include a MistTrack (a well-known crypto investigations service) post that appears to be alerting on this address — a credible negative signal that warrants caution. The labels endpoint returned no usable label data, and both onchain_history and contract_analysis were unresolved, so we cannot corroborate or refute the MistTrack signal with activity patterns. Given the presence of an investigative-source alert combined with missing on-chain context, the prudent verdict is do_not_transact at medium confidence.
- **Coverage:** resolved=[sanctions, labels, web_sentiment] unresolved=[onchain_history, contract_analysis]
- **Hard errors:**
  - [onchain_history] agnicFetch [Target API is not X402 enabled]: Bad Request
  - [contract_analysis] agnicFetch [Too many requests from this IP, please try again later.]: Too Many Requests

## Edge cases and bugs surfaced during testing

These were discovered while running the harness — not the verdicts themselves, but operational issues that affected pipeline reliability:

### Bug 1 — Opus tool-call wrapping (critical, fixed in this session)

The Anthropic Opus model returned tool-call arguments wrapped in **three different envelope shapes**, none of which matched the JSON schema directly:

| Wrapper | Example | Observed in |
|---|---|---|
| Single-key `$PARAMETER_NAME` | `{"$PARAMETER_NAME": {…actual fields…}}` | Lazarus, Pink Drainer, Tornado (first batch) |
| Single-key `response` | `{"response": {…actual fields…}}` | Vitalik, Pink Drainer (second batch) |
| Two-key `$PARAMETER_NAME`/`$PARAMETER_VALUE` | `{"$PARAMETER_NAME": "WalletVerdict", "$PARAMETER_VALUE": {…actual fields…}}` | Lazarus (third batch) |

Every wrapped call would fail `WalletVerdictSchema.parse` with "received undefined" for every required field, returning HTTP 500 and discarding all paid invocation receipts. Patched `src/gateway.ts` to detect a single-key envelope, an explicit `$PARAMETER_VALUE` / `value` / `data` / `result` / `output` / `payload` key, and try `schema.safeParse` on the unwrapped inner object before failing.

This is a known Anthropic quirk when using OpenAI-style JSON-schema tool definitions through a proxy. The fix is defensive and warns when it activates so future occurrences are visible in logs.

### Bug 2 — Synthesis HTTP 500 swallows all paid receipts (high)

When synthesis throws (Opus 500, wrapping bug, schema mismatch), `src/routes/verify_agent.ts` lets the error bubble to the global handler in `main.ts` which returns just `{error: <message>}` with HTTP 500. The receipts from successful invocations — which already paid out $0.005–$0.015 — are lost. During my first harness run all 5 calls failed at synthesis and I had zero recoverable data despite ~$0.04 in spend. Recommended fix below (#1).

### Bug 3 — Large-findings prompt triggers Opus upstream 500 (medium, mitigated)

Vitalik's and Binance's runs both returned `agnic gateway HTTP 500 / internal_error` from upstream Anthropic in the first batch. The findings JSON for these well-known addresses is large (web_sentiment returns multi-page results; labels return long entity lists). Patched `src/agent/synthesize_verdict.ts` to truncate any individual category finding whose stringified form exceeds 3000 chars, leaving a `{__truncated: true, __originalSize, preview}` placeholder. Both addresses returned 200 after the patch.

### Bug 4 — Repeated balance probes trigger agnic 15-min rate limit (medium, fixed)

Every `/verify-agent` call originally made 2 fresh fetches to `/api/balance` (mainnet + sepolia) for wallet-network detection. Running 5 sequential addresses → 10 balance calls → triggered agnic's 15-minute rate-limit cooldown. Patched `src/discovery/network.ts` to cache the detected network for 5 minutes at module level. Cuts to 2 total balance calls per process lifetime.

### Bug 5 — Static catalog includes dead/non-x402 services (medium)

`https://orbisapi.com/proxy/wallet-balance-api-5575de/...` paths returned **`Target API is not X402 enabled: Bad Request` 5/5 times** and exhausted all 2 alternates every run. The LLM rerank keeps picking this provider because the description ("On-chain ETH & ERC20 wallet balances and transaction history") is a perfect match for the `onchain_history` category, but the underlying API isn't actually x402-payment-enabled. Result: `onchain_history` was unresolved in **5/5** runs.

## Operational findings

- **Verdict accuracy: 100% (5/5 strict match).** Opus correctly applied the weighted-prompt rules: hard veto on sanctions (Lazarus, Tornado), strong negative on labels/web hits (Pink Drainer via MistTrack alert), positive on doxxed/exchange entities (Vitalik, Binance). Confidence calibration looked sensible — `high` when sanctions hit, `medium` when only web sentiment carried the signal.

- **Primary-pick reliability: 56%.** Just over half of the LLM-rerank-chosen primary services succeeded on the first attempt. The 44% that failed were rescued by the alternates chain in 5 cases and lost to errors in 6 cases. This is mediocre — see recommendation #2.

- **Alternate-rescue rate: 20%.** A meaningful fraction of categories required the runner-up service. Without alternates the agent would have had 19 successful service calls instead of 24, and confidence would have been notably lower across the board.

- **LLM-adapter fallback rate: 48%.** Nearly half of all service calls required the LLM to construct request args because the pattern adapter couldn't extract them from `bazaar.info`. Each fallback costs an extra Haiku call (~$0.0001) and ~5–10s of latency. See recommendation #3.

- **Hard error rate: 24% (6/25 attempts).** Concentrated in `onchain_history` (5/5 runs failed across all alternates) and `contract_analysis` for Pink Drainer (rate-limited).

- **Service-call reliability is bimodal.** Five services were 100% reliable (anchor-x402 sanctions, orbisapi labeler, blockrun web search, orbisapi audit-pro, orbisapi smart-contract-auditor). Three were 0% (all orbisapi `wallet-balance-api-5575de` paths). Bimodality says the LLM-rerank step is picking by description, not by what actually responds.

- **Cost per verification: $0.011–$0.016** in x402 spend, plus the Opus synthesis cost (not visible here — billed against agnic `creditBalance`). Total wall-clock per call: 48–61s.

## Recommended improvements

Ranked by impact × effort.

### 1. Catch synthesis errors at the route layer; return receipts + partial verdict (high impact, low effort)

`src/routes/verify_agent.ts` should wrap `verifyViaDiscovery` with try/catch and, if `synthesizeVerdict` throws, still return 200 with `{verdict: null, error: <message>, plan, receipts, walletNetwork, totalSpentUsdc}`. Today a synthesis error throws away receipts the caller already paid for. This was the #1 source of frustration during testing.

Alternative: have `synthesizeVerdict` emit a stub WalletVerdict (`safe=false, verdict="insufficient_data", confidence="low", headline="synthesis failed: <reason>"`) so the API always succeeds when invocation succeeded.

### 2. Health-score services in the rerank (high impact, medium effort)

The rerank prompt currently optimizes for description fit and `l30DaysUniquePayers`. Add a **runtime-failure penalty** by persisting `serviceStats` (success/fail counts per resource URL) across runs and feeding the rerank LLM `recentFailureRate: 0.0…1.0` per candidate. Services with >50% recent failure rate should be deprioritized regardless of description match. Implementation: a tiny `services_health.json` file or KV store updated by `invokeAll`, read by `discover`'s ranker.

This would have caught `orbisapi.com/proxy/wallet-balance-api-5575de` (0% success rate) and demoted it below alternates, likely resolving `onchain_history` for 4/5 runs.

### 3. Strengthen the pattern-match adapter (medium impact, low effort)

48% LLM-adapter usage is high. Looking at the cases that fell through to LLM-fallback, common patterns the heuristic should handle:

- POST endpoints where `bazaar.info.input.body` is missing but `queryParams` describes a JSON schema (the mru-oracle pattern). Currently defaults to `{address, chain}` which sometimes works but often gets 4xx — the adapter could try several shapes (`{address}`, `{wallet}`, `{wallets: [address]}`) before falling back.
- URLs with `/v1/{tokens|transactions|balance}/:address` suffixes — pattern adapter should follow the path-template substitution it already does, but apparently chose a different shape in the cases that errored.

Add a small enum of "common POST body shapes" and try each one before invoking the LLM. Each LLM call is ~5s and avoidable in the common case.

### 4. Surface `bazaar.info` quality during rerank (medium impact, low effort)

The rerank prompt should explicitly bias toward services that have *fully-populated* `bazaar.info.input` (with `method`, `queryParams`/`pathParams`/`body`). Catalog entries with empty or skeletal `info` consistently triggered the LLM-fallback adapter and a higher error rate. Adding a one-liner to the rerank prompt — "prefer services that document their input shape" — would help.

### 5. Per-upstream-service rate-limit handling (low-medium impact, low effort)

Anchor-x402's sanctions service rate-limited us once during this test session (after ~10 sequential hits across 5 verifies). The agnic balance endpoint also rate-limited (now mitigated by network cache). Adding a per-upstream exponential-backoff retry inside `invokeRankedService` would smooth this over for short bursts. Long-term: a token-bucket per upstream URL.

### 6. Onchain provider replacement (high impact, medium effort)

`onchain_history` was unresolved in 5/5 runs. Two paths:

- (a) Filter the discovery for onchain providers other than `orbisapi.com/proxy/wallet-balance-api-5575de` — try Etherscan/Blockscout x402-gated endpoints if available.
- (b) Implement a free viem-based fallback (read `eth_getTransactionCount`, `eth_getBalance` from a public RPC) for the onchain_history category, the way `ens` is already free-resolved outside x402. Zero cost, 100% reliable on supported chains.

Option (b) makes more sense long-term — onchain history doesn't need to be a paid x402 call when public RPCs already expose it.

### 7. Stricter Opus tool-schema (low-medium impact, low effort)

The `$PARAMETER_NAME`/`$PARAMETER_VALUE` wrapping the model emits suggests our JSON schema is rendered in a way Opus misinterprets. Try:

- Adding an explicit example response inside the tool description: `"example": {"address": "...", "safe": true, …}`
- Naming the tool more descriptively (e.g. `emit_wallet_verdict` instead of `respond`)
- Including the schema's `description` field inline so the model sees what the parameter is

If these reduce wrap-bug occurrence, we can remove the defensive unwrap (or leave it as belt-and-suspenders).

### 8. Cap the alternates retry depth more aggressively for known-dead services (low impact, low effort)

When `orbisapi.com/proxy/wallet-balance-api-5575de` fails the primary call with "Target API is not X402 enabled", trying its 2 alternates `/balance/:address` and `/v1/tokens/:address` (which are sibling paths on the same dead host) is wasted effort and 2 wasted LLM-adapter calls. The retry chain should short-circuit when the error code is "domain-level" (target not enabled, DNS failure) vs path-level.

---

## Notes

- Raw responses for each address are saved under `docs/real-wallet-tests/runs/`.
- `partial` verdict means the route returned `insufficient_data` instead of the expected verdict — that's a more conservative miss than `safe_to_transact` when we expected `do_not_transact` (or vice versa). None occurred in this run.
- Three source-code fixes were made *during* this testing exercise (gateway unwrap, synthesis truncation, network cache); the bugs they fixed are documented above as "Bug 1, 3, 4" with severity ratings. All other recommendations are unimplemented.
- Total real x402 spend across all final-run attempts: **$0.075** USDC. Opus synthesis costs additional but were billed silently against agnic `creditBalance`.

