# Real-Wallet E2E Test Report — /verify-agent

**Run at:** 2026-05-23T12:47:38.817Z

**Endpoint:** `http://localhost:8000/verify-agent`

**Total addresses:** 4

## Aggregate metrics

- **Total x402 spend:** $0.0696 USDC
- **Total wall-clock:** 135.0s (sequential)
- **Verdict accuracy:** 4 match / 0 partial (insufficient_data) / 0 mismatch / 0 error → 100% strict match
- **Service-call outcomes:** 16 primary-hit / 0 alternate-rescue / 0 hard-error across 16 attempts
- **Primary-pick reliability:** 100% (% of LLM-rerank-chosen services that worked on first attempt)
- **Alternate-rescue rate:** 0% (% of resolved services that came from runner-ups)
- **LLM-adapter usage:** 0% (% of attempts that needed LLM-built call args)

## Per-address summary

| Address | Category | Expected | Actual | Conf | ✓/✗ | Primary | Alt rescue | LLM adapter | Errors | Spend | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `0xd8dA6B…6045` | Vitalik's main wallet (vitalik.eth) | safe_to_transact | safe_to_transact | medium | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 32s |
| `0xf97781…acec` | Binance Hot Wallet 20 | safe_to_transact | safe_to_transact | medium | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 33s |
| `0x098B71…2f96` | Lazarus Group (Ronin bridge hack) | do_not_transact | do_not_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 36s |
| `0xd90e2f…f31b` | Tornado Cash router contract | do_not_transact | do_not_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 33s |

## Per-service reliability

| Service URL | OK | Error | Success rate |
|---|---|---|---|
| `https://api.anchor-x402.com/v1/screen` | 4 | 0 | 100% |
| `https://orbisapi.com/proxy/crypto-address-labeler-api-79be80` | 4 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-api-5f3267/balance/:address` | 4 | 0 | 100% |
| `https://orbisapi.com/proxy/address-reputation-score-api-9d7eb2` | 4 | 0 | 100% |

## Per-address detail

### Vitalik's main wallet (vitalik.eth)

- **Address:** `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `medium`)
- **Headline:** Safe to transact — sanctions screen is clean and the wallet shows an active, funded Ethereum account (vitalik.eth).
- **Reasoning:** The sanctions check returned no matches against the active corpus, which is the most important positive signal. On-chain history shows a funded wallet holding ~5.68 ETH, consistent with a real, active user (this is the well-known vitalik.eth address). The labels and web_sentiment endpoints returned only API metadata rather than substantive label or reputation data, so those signals are inconclusive — neither positive nor negative. Contract analysis is not applicable (EOA). With a clean sanctions result and a healthy on-chain footprint but limited label/sentiment substance, the wallet rates safe with medium confidence.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment] unresolved=[—]

### Binance Hot Wallet 20

- **Address:** `0xf977814e90da44bfa03b6295a0616a897441acec`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `medium`)
- **Headline:** Safe to transact — sanctions screen is clean and the wallet shows a very large, long-standing ETH balance consistent with a major institutional address.
- **Reasoning:** Sanctions check returned no matches against the active corpus, removing the hard veto. On-chain history shows an extremely large balance (~656,224 ETH), which is characteristic of a major custodial/exchange wallet (this address is widely known as a Binance cold wallet) and is a strong positive supporting signal. The labels and web_sentiment endpoints returned only API metadata rather than substantive label or reputation data, so those signals are inconclusive — this limits confidence to medium despite the otherwise positive picture. Contract analysis is not applicable (EOA).
- **Coverage:** resolved=[sanctions, onchain_history] unresolved=[labels, web_sentiment]

### Lazarus Group (Ronin bridge hack)

- **Address:** `0x098B716B8Aaf21512996dC57EB0615e2383E2f96`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** Do not transact — wallet is sanctioned on OFAC SDN and linked to the DPRK Lazarus Group.
- **Reasoning:** The sanctions check returned a confirmed match against three programs: OFAC SDN, Lazarus Group, and DPRK, which is a hard veto under our policy and overrides all other signals. While the wallet shows a substantial ETH balance (~101.8 ETH) indicating active use, this is irrelevant in the face of a confirmed sanctions hit — in fact, it may reflect illicit holdings. The labels and web_sentiment endpoints returned only API metadata rather than usable label/reputation data, but no compensating positive signal could override sanctions. Sending funds to this address would expose the user to severe regulatory and legal consequences.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment] unresolved=[—]

### Tornado Cash router contract

- **Address:** `0xd90e2f925da726b50c4ed8d0fb90ad053324f31b`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** Do not transact — this wallet is on OFAC SDN and linked to Tornado Cash sanctions.
- **Reasoning:** The sanctions screen returned a confirmed match against two programs (OFAC SDN and Tornado Cash) with a high risk level, which is a hard veto regardless of any other signals. On-chain history shows a zero balance with no meaningful activity to interpret, and the labels and web_sentiment endpoints did not return substantive evidence either way. Per policy, a confirmed sanctions hit fixes the verdict to do_not_transact with high confidence.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment] unresolved=[—]

## Notes

- Raw responses for each address are saved under `docs/real-wallet-tests/runs/`.
- `partial` verdict means the route returned `insufficient_data` instead of the expected verdict — that's a more conservative miss than `safe_to_transact` when we expected `do_not_transact` (or vice versa).
