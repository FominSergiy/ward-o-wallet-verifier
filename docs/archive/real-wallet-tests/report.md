# Real-Wallet E2E Test Report — /verify-agent

**Run at:** 2026-05-23T14:20:21.286Z

**Endpoint:** `http://localhost:8000/verify-agent`

**Total addresses:** 4

## Aggregate metrics

- **Total x402 spend:** $0.0546 USDC
- **Total wall-clock:** 164.2s (sequential)
- **Verdict accuracy:** 4 match / 0 partial (insufficient_data) / 0 mismatch / 0 error → 100% strict match
- **Service-call outcomes:** 14 primary-hit / 0 alternate-rescue / 2 hard-error across 16 attempts
- **Primary-pick reliability:** 88% (% of LLM-rerank-chosen services that worked on first attempt)
- **Alternate-rescue rate:** 0% (% of resolved services that came from runner-ups)
- **LLM-adapter usage:** 13% (% of attempts that needed LLM-built call args)

## Per-address summary

| Address | Category | Expected | Actual | Conf | ✓/✗ | Primary | Alt rescue | LLM adapter | Errors | Spend | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `0xd8dA6B…6045` | Vitalik's main wallet (vitalik.eth) | safe_to_transact | safe_to_transact | medium | ✓ | 3 | 0 | 1 | 1 | $0.0099 | 45s |
| `0xf97781…acec` | Binance Hot Wallet 20 | safe_to_transact | safe_to_transact | medium | ✓ | 3 | 0 | 1 | 1 | $0.0099 | 40s |
| `0x098B71…2f96` | Lazarus Group (Ronin bridge hack) | do_not_transact | do_not_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 39s |
| `0xd90e2f…f31b` | Tornado Cash router contract | do_not_transact | do_not_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 39s |

## Per-service reliability

| Service URL | OK | Error | Success rate |
|---|---|---|---|
| `https://api.anchor-x402.com/v1/screen` | 4 | 0 | 100% |
| `https://orbisapi.com/proxy/crypto-address-labeler-api-79be80` | 4 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-api-5f3267/balance/:address` | 4 | 0 | 100% |
| `https://orbisapi.com/proxy/address-reputation-score-api-9d7eb2` | 2 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-address-risk-api-c6680c/:endpoint` | 0 | 1 | 0% |
| `https://orbisapi.com/proxy/wallet-risk-score-api-d4822c` | 0 | 1 | 0% |

## Per-address detail

### Vitalik's main wallet (vitalik.eth)

- **Address:** `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `medium`)
- **Headline:** Safe to transact — sanctions screen is clean and the wallet shows a healthy, active on-chain balance, though no positive labels were confirmed.
- **Reasoning:** The sanctions check returned no matches against the active sanctions corpus, which is the strongest positive signal. The wallet holds ~5.68 ETH, consistent with an active, real user rather than a dormant or throwaway address. Labels came back as unknown (neutral, not negative) and web sentiment was unresolved, so confidence is held to medium rather than high. No risk-indicative terms or contract vulnerabilities were detected, and contract analysis is not applicable since this is an EOA.
- **Coverage:** resolved=[sanctions, labels, onchain_history] unresolved=[web_sentiment]
- **Hard errors:**
  - [web_sentiment] agnicFetch [non_json_response]: HTTP 404 Not Found returned non-JSON body (<!DOCTYPE html> <html lang="en"> <head> <meta charset="utf-8"> <title>Error</title> </head> <body> <pre>Cannot POST /wallet-address-risk/:endpoint</pre> </body> </html>)

### Binance Hot Wallet 20

- **Address:** `0xf977814e90da44bfa03b6295a0616a897441acec`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `medium`)
- **Headline:** Safe to transact — sanctions screen is clean and the wallet holds a very large, long-standing ETH balance consistent with a major institutional address.
- **Reasoning:** Sanctions screening returned no matches against the active corpus, removing the hard-veto risk. The wallet currently holds ~656,224 ETH, a balance characteristic of a major exchange/institutional cold wallet (this address is widely known as Binance 8), which is a strong positive on-chain signal. The label provider did not return a known tag and web sentiment was unresolved, so some confirmatory context is missing, keeping confidence at medium rather than high. No negative labels, contract risk (EOA, N/A), or adverse signals were detected.
- **Coverage:** resolved=[sanctions, labels, onchain_history] unresolved=[web_sentiment]
- **Hard errors:**
  - [web_sentiment] agnicFetch [Not found]: Not Found

### Lazarus Group (Ronin bridge hack)

- **Address:** `0x098B716B8Aaf21512996dC57EB0615e2383E2f96`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** Do NOT transact — this wallet is on multiple sanctions lists including OFAC SDN and is linked to the DPRK Lazarus Group.
- **Reasoning:** The sanctions screen returned a confirmed hit against three programs: OFAC SDN, Lazarus Group, and DPRK. Per policy, a sanctions match is a hard veto that overrides all other signals, regardless of other neutral or positive indicators. While the wallet holds a substantial ETH balance (~101.8 ETH) and has no specific scam labels attached, sending funds to an OFAC-sanctioned address exposes the sender to severe legal and financial penalties. Web sentiment and labels returned no offsetting positive entity attestations.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment] unresolved=[—]

### Tornado Cash router contract

- **Address:** `0xd90e2f925da726b50c4ed8d0fb90ad053324f31b`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** Do not transact — this wallet is on the OFAC SDN sanctions list (Tornado Cash).
- **Reasoning:** The sanctions screen returned a confirmed match against both the OFAC SDN list and the Tornado Cash designation, which is a hard veto under our rules and overrides all other signals. Sending funds to this address could expose the sender to severe regulatory and legal consequences. Supporting signals are neutral-to-weak (no known label, zero balance, no useful web sentiment data), but none can offset a sanctions hit. Confidence is high because the sanctions data source returned an unambiguous match.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment] unresolved=[—]

## Notes

- Raw responses for each address are saved under `docs/real-wallet-tests/runs/`.
- `partial` verdict means the route returned `insufficient_data` instead of the expected verdict — that's a more conservative miss than `safe_to_transact` when we expected `do_not_transact` (or vice versa).
