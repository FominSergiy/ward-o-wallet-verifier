# Real-Wallet E2E Test Report — /verify-agent

**Run at:** 2026-05-23T12:33:32.576Z

**Endpoint:** `http://localhost:8000/verify-agent`

**Total addresses:** 4

## Aggregate metrics

- **Total x402 spend:** $0.0501 USDC
- **Total wall-clock:** 204.5s (sequential)
- **Verdict accuracy:** 4 match / 0 partial (insufficient_data) / 0 mismatch / 0 error → 100% strict match
- **Service-call outcomes:** 15 primary-hit / 1 alternate-rescue / 0 hard-error across 16 attempts
- **Primary-pick reliability:** 94% (% of LLM-rerank-chosen services that worked on first attempt)
- **Alternate-rescue rate:** 6% (% of resolved services that came from runner-ups)
- **LLM-adapter usage:** 0% (% of attempts that needed LLM-built call args)

## Per-address summary

| Address | Category | Expected | Actual | Conf | ✓/✗ | Primary | Alt rescue | LLM adapter | Errors | Spend | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `0xd8dA6B…6045` | Vitalik's main wallet (vitalik.eth) | safe_to_transact | safe_to_transact | medium | ✓ | 3 | 1 | 0 | 0 | $0.0109 | 67s |
| `0xf97781…acec` | Binance Hot Wallet 20 | safe_to_transact | safe_to_transact | medium | ✓ | 4 | 0 | 0 | 0 | $0.0109 | 45s |
| `0x098B71…2f96` | Lazarus Group (Ronin bridge hack) | do_not_transact | do_not_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0109 | 44s |
| `0xd90e2f…f31b` | Tornado Cash router contract | do_not_transact | do_not_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 48s |

## Per-service reliability

| Service URL | OK | Error | Success rate |
|---|---|---|---|
| `https://api.anchor-x402.com/v1/screen` | 4 | 0 | 100% |
| `https://orbisapi.com/proxy/crypto-address-labeler-api-79be80` | 4 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-api-5f3267/balance/:address` | 4 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-address-risk-api-c6680c` | 3 | 0 | 100% |
| `https://orbisapi.com/proxy/address-reputation-score-api-9d7eb2` | 1 | 0 | 100% |

## Per-address detail

### Vitalik's main wallet (vitalik.eth)

- **Address:** `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `medium`)
- **Headline:** Safe to transact — sanctions screen is clean and the wallet shows a healthy, active on-chain footprint (vitalik.eth).
- **Reasoning:** The sanctions check returned no matches against the active corpus, which is the most important positive signal. On-chain history shows a non-zero balance (~5.68 ETH) on a well-known Ethereum address (commonly recognized as vitalik.eth). The labels and web_sentiment endpoints did not return substantive content (only API metadata), so they are treated as neutral rather than negative. With one strong positive (sanctions clean) and one supporting positive (active wallet with meaningful balance), and no negative indicators anywhere, the wallet is safe to transact with at medium confidence.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment] unresolved=[—]

### Binance Hot Wallet 20

- **Address:** `0xf977814e90da44bfa03b6295a0616a897441acec`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `medium`)
- **Headline:** Safe to transact — sanctions screen is clean and the wallet shows a very large, long-standing on-chain balance consistent with a major institutional address.
- **Reasoning:** Sanctions screening returned no matches against the active corpus, removing the hard veto. On-chain history shows an extremely large balance (~656,224 ETH), which is characteristic of a major exchange or institutional wallet (this address is widely known as a Binance cold wallet) and is a strong positive supporting signal. The labels and web_sentiment endpoints returned only API metadata rather than concrete label/sentiment data, so those categories did not contribute usable evidence — this caps confidence at medium. No negative signals were observed across any resolved category.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment] unresolved=[—]

### Lazarus Group (Ronin bridge hack)

- **Address:** `0x098B716B8Aaf21512996dC57EB0615e2383E2f96`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** Do not transact — this wallet is on OFAC SDN and linked to the DPRK Lazarus Group.
- **Reasoning:** The sanctions check returned a definitive match against three programs: OFAC SDN, Lazarus Group, and DPRK, which is a hard veto regardless of any other signal. On-chain history shows a substantial ETH balance (~101.8 ETH), but balance alone cannot offset a confirmed sanctions hit. Labels and web sentiment endpoints returned only API metadata (no actual label or sentiment data), so they provide no compensating positive evidence. Per policy, a sanctions match forces safe=false, verdict=do_not_transact, with high confidence.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment] unresolved=[—]

### Tornado Cash router contract

- **Address:** `0xd90e2f925da726b50c4ed8d0fb90ad053324f31b`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** Do not transact — this address is on the OFAC SDN sanctions list and linked to Tornado Cash.
- **Reasoning:** Sanctions screening returned a confirmed match against two programs (OFAC SDN and Tornado Cash) with a high risk level, which is a hard veto regardless of any other signals. The on-chain history shows a zero ETH balance, consistent with a dormant or drained sanctioned address, providing no offsetting positive evidence. Labels and web sentiment returned only API descriptors rather than meaningful data, but they cannot override the sanctions hit. Sending funds to this wallet would likely constitute a sanctions violation.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment] unresolved=[—]

## Notes

- Raw responses for each address are saved under `docs/real-wallet-tests/runs/`.
- `partial` verdict means the route returned `insufficient_data` instead of the expected verdict — that's a more conservative miss than `safe_to_transact` when we expected `do_not_transact` (or vice versa).
