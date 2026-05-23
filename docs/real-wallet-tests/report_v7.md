# Real-Wallet E2E Test Report — /verify-agent

**Run at:** 2026-05-23T19:54:36.882Z

**Endpoint:** `http://localhost:8000/verify-agent`

**Total addresses:** 9

## Aggregate metrics

- **Total x402 spend:** $0.1218 USDC
- **Total wall-clock:** 301.0s (sequential)
- **Verdict accuracy:** 9 match / 0 partial (insufficient_data) / 0 mismatch / 0 error → 100% strict match
- **Service-call outcomes:** 28 primary-hit / 0 alternate-rescue / 0 hard-error across 28 attempts
- **Primary-pick reliability:** 100% (% of LLM-rerank-chosen services that worked on first attempt)
- **Alternate-rescue rate:** 0% (% of resolved services that came from runner-ups)
- **LLM-adapter usage:** 0% (% of attempts that needed LLM-built call args)

## Per-address summary

| Address | Category | Expected | Actual | Conf | ✓/✗ | Primary | Alt rescue | LLM adapter | Errors | Spend | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `0xd8dA6B…6045` | Vitalik's main wallet (vitalik.eth) | safe_to_transact | safe_to_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 44s |
| `0xf97781…acec` | Binance Hot Wallet 20 | safe_to_transact | safe_to_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 41s |
| `0x098B71…2f96` | Lazarus Group (Ronin bridge hack) | do_not_transact | do_not_transact | high | ✓ | 0 | 0 | 0 | 0 | $0.0000 | 3s |
| `0xd90e2f…f31b` | Tornado Cash router contract | do_not_transact | do_not_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 40s |
| `0x71660c…75d3` | Coinbase 1 hot wallet | safe_to_transact | safe_to_transact | medium | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 44s |
| `0x291054…63D2` | Kraken 4 hot wallet | safe_to_transact | safe_to_transact | medium | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 40s |
| `0x7F367c…be1B` | OFAC SDN Tornado Cash deposit | do_not_transact | do_not_transact | high | ✓ | 0 | 0 | 0 | 0 | $0.0000 | 2s |
| `0xb8c2C2…67d5` | Nick Johnson (nick.eth, ENS founder) | safe_to_transact | safe_to_transact | high | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 38s |
| `0xAaBbCc…CcDd` | Synthetic fresh wallet (no history) | insufficient_data | insufficient_data | low | ✓ | 4 | 0 | 0 | 0 | $0.0174 | 49s |

## Per-service reliability

| Service URL | OK | Error | Success rate |
|---|---|---|---|
| `https://api.anchor-x402.com/v1/screen` | 7 | 0 | 100% |
| `https://orbisapi.com/proxy/crypto-address-labeler-api-79be80` | 7 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-api-5f3267/balance/:address` | 7 | 0 | 100% |
| `https://orbisapi.com/proxy/address-reputation-score-api-9d7eb2` | 7 | 0 | 100% |

## Per-address detail

### Vitalik's main wallet (vitalik.eth)

- **Address:** `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `high`)
- **Headline:** Safe to transact — wallet resolves to the publicly doxxed ENS "vitalik.eth" with clean sanctions screening.
- **Reasoning:** Both the Chainalysis on-chain oracle and the x402 sanctions service returned no match, satisfying the sanctions-clean requirement at high confidence. ENS reverse resolution returns "vitalik.eth", which is a strong positive identity signal (publicly doxxed wallet of a well-known individual). On-chain history shows a non-zero balance (~5.68 ETH), providing supporting positive evidence. No negative labels or adverse web sentiment were surfaced, and contract analysis is N/A (EOA).
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

### Binance Hot Wallet 20

- **Address:** `0xf977814e90da44bfa03b6295a0616a897441acec`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `high`)
- **Headline:** Safe to transact — sanctions checks are clean and the wallet has a long-standing, high-balance on-chain footprint consistent with a major known entity (Binance cold wallet).
- **Reasoning:** Both the Chainalysis on-chain oracle and the x402 sanctions service returned clean (not sanctioned). The wallet holds ~656,224 ETH, a balance consistent with a major institutional/exchange wallet (widely known as a Binance cold wallet), which is strong positive supporting evidence. Labels and ENS returned no explicit match, and web sentiment surfaced no negative reports. With two independent sanctions-clean sources plus very substantial verified on-chain activity, confidence is high.
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
- **Headline:** Do not transact — this address matches OFAC SDN and Tornado Cash sanctions lists.
- **Reasoning:** The x402 sanctions service returned a confirmed match against OFAC SDN and Tornado Cash with high risk level, which is a hard veto regardless of other signals. Although the Chainalysis on-chain oracle returned isSanctioned=false (possibly due to oracle list lag or scope), a confirmed sanctions hit from any authoritative source mandates a do_not_transact verdict. Supporting context (no ENS, no known label, zero balance) is consistent with a flagged/abandoned sanctioned address and does nothing to mitigate the risk. Sending funds to this wallet could expose the sender to serious legal and regulatory consequences.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

### Coinbase 1 hot wallet

- **Address:** `0x71660c4005BA85c37ccec55d0C4493E66Fe775d3`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `medium`)
- **Headline:** Safe to transact — sanctions screens are clean and the wallet shows a healthy on-chain balance with no negative signals.
- **Reasoning:** Both the Chainalysis on-chain oracle and the x402 sanctions service returned clean (not sanctioned), which is the strongest deterministic signal available. The address has no known label (positive or negative) and no adverse web-sentiment hits, while on-chain history shows a substantial ~11.08 ETH balance, suggesting a real, funded wallet rather than a throwaway. ENS is not set, which is neutral. With sanctions clean and no negative indicators across labels, history, or sentiment, the wallet is safe to transact with at medium confidence (lack of an identifying label prevents a high-confidence positive).
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

### Kraken 4 hot wallet

- **Address:** `0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `medium`)
- **Headline:** Safe to transact — sanctions screens are clean and no risk signals were detected on this active Ethereum wallet.
- **Reasoning:** Both the Chainalysis on-chain oracle (sourced from OFAC SDN) and the x402 sanctions service returned clean results, satisfying the most important screening requirement with high trust. The address labeler returned no known entity and no negative tags (no scam/mixer/phisher markers), and the on-chain history shows a non-zero ETH balance, indicating a live wallet. Web sentiment returned no adverse hits and ENS is absent (neutral). With no negative signals across any category and two independent sanctions sources confirming clean status, the wallet is safe to send funds to, though confidence is held at medium because the address has no positive identifying labels or ENS to corroborate identity.
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
- **Headline:** Safe to transact — wallet is ENS-doxxed as nick.eth with clean sanctions checks and a long-standing on-chain balance.
- **Reasoning:** Both the Chainalysis on-chain oracle and the x402 sanctions service returned clean results, satisfying the sanctions requirement with high confidence. The address reverse-resolves to "nick.eth" via ENS, a publicly doxxed identity, which is strong positive evidence equivalent to a known-safe label. On-chain history shows a substantial ETH balance (~149.66 ETH), and no negative labels or web-sentiment hits were found. Contract analysis is not applicable (EOA).
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

### Synthetic fresh wallet (no history)

- **Address:** `0xAaBbCcDdEeFf00112233445566778899AaBbCcDd`
- **Expected:** `insufficient_data`
- **Actual:** `insufficient_data` (confidence: `low`)
- **Headline:** Insufficient data to confirm safety — sanctions are clean, but the wallet has no balance, no labels, no ENS, and no usable reputation data.
- **Reasoning:** Sanctions screening returned no matches, which is a positive deterministic signal. However, the address has no known label, no ENS reverse record, a zero ETH balance, and the web_sentiment lookup returned only API metadata rather than any actual reputation findings. With no positive identity or activity signals to corroborate safety and no negative signals to condemn it, there is not enough usable evidence to recommend transacting. A user should independently verify the recipient via an out-of-band channel before sending funds.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, ens] unresolved=[—]

## Notes

- Raw responses for each address are saved under `docs/real-wallet-tests/runs/`.
- `partial` verdict means the route returned `insufficient_data` instead of the expected verdict — that's a more conservative miss than `safe_to_transact` when we expected `do_not_transact` (or vice versa).
