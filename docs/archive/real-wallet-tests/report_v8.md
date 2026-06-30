# Real-Wallet E2E Test Report — /verify-agent

**Run at:** 2026-05-23T22:20:04.759Z

**Endpoint:** `http://localhost:8001/verify-agent`

**Total addresses:** 9

## Aggregate metrics

- **Total x402 spend:** $0.0753 USDC
- **Total wall-clock:** 379.3s (sequential)
- **Verdict accuracy:** 9 match / 0 partial (insufficient_data) / 0 mismatch / 0 error → 100% strict match
- **Service-call outcomes:** 27 primary-hit / 0 alternate-rescue / 1 hard-error across 28 attempts
- **Primary-pick reliability:** 96% (% of LLM-rerank-chosen services that worked on first attempt)
- **Alternate-rescue rate:** 0% (% of resolved services that came from runner-ups)
- **LLM-adapter usage:** 7% (% of attempts that needed LLM-built call args)

## Per-address summary

| Address | Category | Expected | Actual | Conf | ✓/✗ | Primary | Alt rescue | LLM adapter | Errors | Spend | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `0xd8dA6B…6045` | Vitalik's main wallet (vitalik.eth) | safe_to_transact | safe_to_transact | high | ✓ | 3 | 0 | 1 | 1 | $0.0099 | 136s |
| `0xf97781…acec` | Binance Hot Wallet 20 | safe_to_transact | safe_to_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0109 | 57s |
| `0x098B71…2f96` | Lazarus Group (Ronin bridge hack) | do_not_transact | do_not_transact | high | ✓ | 0 | 0 | 0 | 0 | $0.0000 | 2s |
| `0xd90e2f…f31b` | Tornado Cash router contract | do_not_transact | do_not_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0109 | 39s |
| `0x71660c…75d3` | Coinbase 1 hot wallet | safe_to_transact | safe_to_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0109 | 38s |
| `0x291054…63D2` | Kraken 4 hot wallet | safe_to_transact | safe_to_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0109 | 31s |
| `0x7F367c…be1B` | OFAC SDN Tornado Cash deposit | do_not_transact | do_not_transact | high | ✓ | 0 | 0 | 0 | 0 | $0.0000 | 3s |
| `0xb8c2C2…67d5` | Nick Johnson (nick.eth, ENS founder) | safe_to_transact | safe_to_transact | high | ✓ | 4 | 0 | 1 | 0 | $0.0109 | 39s |
| `0xAaBbCc…CcDd` | Synthetic fresh wallet (no history) | insufficient_data | insufficient_data | low | ✓ | 4 | 0 | 0 | 0 | $0.0109 | 34s |

## Per-service reliability

| Service URL | OK | Error | Success rate |
|---|---|---|---|
| `https://api.anchor-x402.com/v1/screen` | 7 | 0 | 100% |
| `https://orbisapi.com/proxy/crypto-address-labeler-api-79be80` | 7 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-api-5f3267/balance/:address` | 7 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-address-risk-api-c6680c` | 6 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-address-risk-api-c6680c/:endpoint` | 0 | 1 | 0% |

## Per-address detail

### Vitalik's main wallet (vitalik.eth)

- **Address:** `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `high`)
- **Headline:** Safe to transact — wallet is publicly doxxed as vitalik.eth and passes all sanctions checks.
- **Reasoning:** Both sanctions sources (Chainalysis on-chain oracle and the x402 sanctions service) returned clean results, satisfying the most important screening requirement. The wallet resolves via ENS to vitalik.eth, a strong public identity attribution comparable to a known-safe label. On-chain history shows a healthy non-zero balance (~5.68 ETH) on a well-known long-lived address, providing additional positive supporting evidence. Web sentiment was unresolved and contract analysis is not applicable (EOA), but these do not undermine the strong positives.
- **Coverage:** resolved=[sanctions, labels, onchain_history, ens] unresolved=[web_sentiment]
- **Hard errors:**
  - [web_sentiment] agnicFetch [non_json_response]: HTTP 404 Not Found returned non-JSON body (<!DOCTYPE html> <html lang="en"> <head> <meta charset="utf-8"> <title>Error</title> </head> <body> <pre>Cannot POST /wallet-address-risk/:endpoint</pre> </body> </html>)

### Binance Hot Wallet 20

- **Address:** `0xf977814e90da44bfa03b6295a0616a897441acec`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `high`)
- **Headline:** Safe to transact — this address is a labeled Binance hot wallet with clean sanctions screening.
- **Reasoning:** Both the Chainalysis on-chain oracle and the x402 sanctions service returned clean (no match). The eth-labels registry identifies the address as "Binance: Hot Wallet 20" — a strong positive attribution to a major centralized exchange. On-chain history shows a very large ETH balance (~656,224 ETH), consistent with an active CEX hot wallet. No negative web sentiment or risky label terms were detected; ENS is absent but irrelevant given the strong exchange attribution.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

### Lazarus Group (Ronin bridge hack)

- **Address:** `0x098B716B8Aaf21512996dC57EB0615e2383E2f96`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** Do not transact — address is flagged by the Chainalysis on-chain sanctions oracle.
- **Reasoning:** The Chainalysis sanctions oracle (0x40C57923924B5c5c5455c48D93317139ADDaC8fb) returned isSanctioned=true for this address on eth. This oracle is sourced from OFAC SDN and other government sanctions lists. The signal is deterministic and overrides all other evidence; downstream x402 service calls were skipped to avoid unnecessary spend.
- **Coverage:** resolved=[sanctions] unresolved=[labels, onchain_history, web_sentiment, ens]

### Tornado Cash router contract

- **Address:** `0xd90e2f925da726b50c4ed8d0fb90ad053324f31b`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** Do not transact — this address is a Tornado Cash router flagged on OFAC SDN sanctions lists.
- **Reasoning:** The x402 sanctions service returned a direct match against OFAC SDN and Tornado Cash sanctions programs, which is a hard veto regardless of any other signal. This is independently corroborated by the eth-labels registry, which attributes the address as "Tornado.Cash: Router" with labels including "blocked", "ofac-sanctions-lists", and "tornado-cash". Although the Chainalysis on-chain oracle returned isSanctioned=false (likely a gap in that specific oracle's list), the convergence of x402 sanctions data and high-trust registry attribution leaves no doubt. Sending funds here would violate U.S. sanctions and likely result in immediate loss of funds and legal exposure.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

### Coinbase 1 hot wallet

- **Address:** `0x71660c4005BA85c37ccec55d0C4493E66Fe775d3`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `high`)
- **Headline:** Safe to transact — this is a labeled Coinbase exchange hot wallet with a clean sanctions screen.
- **Reasoning:** The Chainalysis on-chain oracle and the x402 sanctions service both return clean (no SDN/sanctions match). The eth-labels registry attributes this address to "Coinbase 1" with labels "coinbase" and "fiat-gateway" — a major, well-known centralized exchange hot wallet, which is strong positive attribution. On-chain history shows a healthy ~11.08 ETH balance consistent with an active exchange wallet, and no negative web sentiment or contract risk applies (EOA). With multiple independent positive signals and no negatives, confidence is high.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

### Kraken 4 hot wallet

- **Address:** `0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `high`)
- **Headline:** Safe to transact — this address is a labeled Kraken exchange hot wallet with a clean sanctions screen.
- **Reasoning:** Both sanctions sources (Chainalysis on-chain oracle and the x402 sanctions service) returned clean, deterministic non-matches. The eth-labels.com registry attributes this address to Kraken ("Kraken" and "Kraken 1" name tags), a major regulated centralized exchange — a strong positive attribution comparable to ENS-doxxed identity. On-chain history confirms an active wallet with a non-zero ETH balance, and no negative web sentiment or risk labels were found. With multiple high-trust signals aligning, confidence is high.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

### OFAC SDN Tornado Cash deposit

- **Address:** `0x7F367cC41522cE07553e823bf3be79A889DEbe1B`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** Do not transact — address is flagged by the Chainalysis on-chain sanctions oracle.
- **Reasoning:** The Chainalysis sanctions oracle (0x40C57923924B5c5c5455c48D93317139ADDaC8fb) returned isSanctioned=true for this address on eth. This oracle is sourced from OFAC SDN and other government sanctions lists. The signal is deterministic and overrides all other evidence; downstream x402 service calls were skipped to avoid unnecessary spend.
- **Coverage:** resolved=[sanctions] unresolved=[labels, onchain_history, web_sentiment, ens]

### Nick Johnson (nick.eth, ENS founder)

- **Address:** `0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `high`)
- **Headline:** Safe to transact — wallet is ENS-doxxed as nick.eth, clean on sanctions, and has substantial on-chain history.
- **Reasoning:** Both sanctions sources (Chainalysis on-chain oracle and the x402 sanctions service) returned clean results, satisfying the hard-veto check. The wallet resolves via ENS reverse lookup to "nick.eth", a publicly-doxxed identity, which is strong positive evidence comparable to a known-safe label. On-chain history shows a healthy balance of ~149.66 ETH, consistent with an established, actively-used wallet. Labels returned no negative attribution from either the x402 labeler or the eth-labels registry, and no adverse web sentiment was found.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

### Synthetic fresh wallet (no history)

- **Address:** `0xAaBbCcDdEeFf00112233445566778899AaBbCcDd`
- **Expected:** `insufficient_data`
- **Actual:** `insufficient_data` (confidence: `low`)
- **Headline:** Insufficient data — sanctions are clean but the wallet has no labels, no ENS, no balance, and no observable history.
- **Reasoning:** The sanctions check returned no matches, which is a positive signal, but every other category is essentially empty: the labeler has no attribution, there is no ENS reverse record, the on-chain balance is zero, and web sentiment returned no substantive content. With only one usable positive signal (sanctions-clean) and no corroborating identity, label, or history evidence, there is not enough information to affirmatively recommend sending funds. This is the classic "unknown wallet" case — not provably bad, but not verifiable as safe either.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

## Notes

- Raw responses for each address are saved under `docs/real-wallet-tests/runs/`.
- `partial` verdict means the route returned `insufficient_data` instead of the expected verdict — that's a more conservative miss than `safe_to_transact` when we expected `do_not_transact` (or vice versa).
