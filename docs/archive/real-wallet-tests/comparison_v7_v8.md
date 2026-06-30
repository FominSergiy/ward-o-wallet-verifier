# v1 vs v2 Comparison — /verify-agent

**Generated:** 2026-05-23T22:21:00.898Z

v1 = pre-fix baseline (9 runs)
v2 = post-fix run (9 runs)

## Headline metrics

| Metric | v1 | v2 | Delta | Target |
|---|---|---|---|---|
| Verdict accuracy (strict match) | 9/9 | 9/9 | 100% → 100% | ≥ 5/5 |
| Primary-pick reliability | 100% | 96% | 100% ↓ 96% | ≥ 70% |
| Alternate-rescue rate | 0% | 0% | 0% → 0% | (info) |
| LLM-adapter usage rate | 0% | 7% | 0% ↑ 7% | ≤ 25% |
| Hard-error rate | 0% | 4% | 0% ↑ 4% | (lower better) |
| onchain_history resolved | 7/9 | 7/9 | 78% → 78% | ≥ 4/5 |
| Total x402 spend (USDC) | $0.1218 | $0.0753 | 0.12$ ↓ 0.08$ | similar |
| Total wall-clock | 301.0s | 379.3s | 301.03s ↑ 379.34s | (info) |

## Per-address comparison

| Address | Label | v1 verdict | v2 verdict | v1 ✓ | v2 ✓ |
|---|---|---|---|---|---|
| `0xd90e2f…f31b` | Tornado Cash router contract | do_not_transact | do_not_transact | ✓ | ✓ |
| `0xAaBbCc…CcDd` | Synthetic fresh wallet (no history) | insufficient_data | insufficient_data | ✓ | ✓ |
| `0x71660c…75d3` | Coinbase 1 hot wallet | safe_to_transact | safe_to_transact | ✓ | ✓ |
| `0x291054…63D2` | Kraken 4 hot wallet | safe_to_transact | safe_to_transact | ✓ | ✓ |
| `0xf97781…acec` | Binance Hot Wallet 20 | safe_to_transact | safe_to_transact | ✓ | ✓ |
| `0xb8c2C2…67d5` | Nick Johnson (nick.eth, ENS founder) | safe_to_transact | safe_to_transact | ✓ | ✓ |
| `0xd8dA6B…6045` | Vitalik's main wallet (vitalik.eth) | safe_to_transact | safe_to_transact | ✓ | ✓ |
| `0x098B71…2f96` | Lazarus Group (Ronin bridge hack) | do_not_transact | do_not_transact | ✓ | ✓ |
| `0x7F367c…be1B` | OFAC SDN Tornado Cash deposit | do_not_transact | do_not_transact | ✓ | ✓ |

