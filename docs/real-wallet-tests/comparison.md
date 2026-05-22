# v1 vs v2 Comparison — /verify-agent

**Generated:** 2026-05-22T11:18:22.252Z

v1 = pre-fix baseline (5 runs)
v2 = post-fix run (5 runs)

## Headline metrics

| Metric | v1 | v2 | Delta | Target |
|---|---|---|---|---|
| Verdict accuracy (strict match) | 5/5 | 3/5 | 100% ↓ 60% | ≥ 5/5 |
| Primary-pick reliability | 56% | 40% | 56% ↓ 40% | ≥ 70% |
| Alternate-rescue rate | 20% | 10% | 20% ↓ 10% | (info) |
| LLM-adapter usage rate | 48% | 45% | 48% ↓ 45% | ≤ 25% |
| Hard-error rate | 24% | 50% | 24% ↑ 50% | (lower better) |
| onchain_history resolved | 0/5 | 2/5 | 0% ↑ 40% | ≥ 4/5 |
| Total x402 spend (USDC) | $0.0750 | $0.0263 | 0.07$ ↓ 0.03$ | similar |
| Total wall-clock | 269.8s | 293.2s | 269.79s ↑ 293.19s | (info) |

## Per-address comparison

| Address | Label | v1 verdict | v2 verdict | v1 ✓ | v2 ✓ |
|---|---|---|---|---|---|
| `0xd90e2f…f31b` | Tornado Cash router contract | do_not_transact | insufficient_data | ✓ | ≈ |
| `0xa5e4b4…4f83` | Pink Drainer scam wallet | do_not_transact | — | ✓ | ✗ err |
| `0xf97781…acec` | Binance Hot Wallet 20 | safe_to_transact | safe_to_transact | ✓ | ✓ |
| `0xd8dA6B…6045` | Vitalik's main wallet (vitalik.eth) | safe_to_transact | safe_to_transact | ✓ | ✓ |
| `0x098B71…2f96` | Lazarus Group (Ronin bridge hack) | do_not_transact | do_not_transact | ✓ | ✓ |

