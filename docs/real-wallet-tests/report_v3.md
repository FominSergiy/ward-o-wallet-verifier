# Real-Wallet E2E Test Report — /verify-agent

**Run at:** 2026-05-22T16:42:08.673Z

**Endpoint:** `http://localhost:8000/verify-agent`

**Total addresses:** 2

## Aggregate metrics

- **Total x402 spend:** $0.0293 USDC
- **Total wall-clock:** 100.0s (sequential)
- **Verdict accuracy:** 2 match / 0 partial (insufficient_data) / 0 mismatch / 0 error → 100% strict match
- **Service-call outcomes:** 8 primary-hit / 1 alternate-rescue / 1 hard-error across 10 attempts
- **Primary-pick reliability:** 80% (% of LLM-rerank-chosen services that worked on first attempt)
- **Alternate-rescue rate:** 10% (% of resolved services that came from runner-ups)
- **LLM-adapter usage:** 30% (% of attempts that needed LLM-built call args)

## Per-address summary

| Address | Category | Expected | Actual | Conf | ✓/✗ | Primary | Alt rescue | LLM adapter | Errors | Spend | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `0x71660c…75d3` | Coinbase 1 cold wallet | safe_to_transact | safe_to_transact | high | ✓ | 3 | 1 | 2 | 1 | $0.0121 | 59s |
| `0xa7e5d5…b008` | Garantex exchange (OFAC-sanctioned) | do_not_transact | do_not_transact | high | ✓ | 5 | 0 | 1 | 0 | $0.0171 | 41s |

## Per-service reliability

| Service URL | OK | Error | Success rate |
|---|---|---|---|
| `https://api.anchor-x402.com/v1/screen` | 2 | 0 | 100% |
| `https://public.zapper.xyz/x402/transaction-history` | 2 | 0 | 100% |
| `https://orbisapi.com/proxy/smart-contract-auditor-api-0061a9` | 2 | 0 | 100% |
| `https://orbisapi.com/proxy/wallet-cluster-score-api-32f2cb/bulk` | 0 | 1 | 0% |
| `https://blockrun.ai/api/v1/surf/search/social/posts` | 1 | 0 | 100% |
| `https://blockrun.ai/api/v1/pm/polymarket/wallet/identity/:address` | 1 | 0 | 100% |
| `https://blockrun.ai/api/v1/surf/search/news` | 1 | 0 | 100% |

## Per-address detail

### Coinbase 1 cold wallet

- **Address:** `0x71660c4005ba85c37ccec55d0c4493e66fe775d3`
- **Expected:** `safe_to_transact`
- **Actual:** `safe_to_transact` (confidence: `high`)
- **Headline:** Safe to transact — this address is widely identified as a Coinbase custody wallet with no sanctions hits.
- **Reasoning:** Sanctions screening returned no matches against the active corpus. Web sentiment strongly and repeatedly identifies the address as a Coinbase Custody wallet receiving large institutional ETH transfers, with no scam/hack/exploit references. On-chain history shows ongoing, multi-chain inbound activity consistent with an active custodial address. The labels provider was unresolved, but the other three positive signals are consistent and corroborating, so confidence remains high.
- **Coverage:** resolved=[sanctions, onchain_history, web_sentiment, contract_analysis] unresolved=[labels]
- **Hard errors:**
  - [labels] agnicFetch [Payment exceeds maximum allowed value]: Payment Required

### Garantex exchange (OFAC-sanctioned)

- **Address:** `0xa7e5d5a720f06526557c513402f2e6b5fa20b008`
- **Expected:** `do_not_transact`
- **Actual:** `do_not_transact` (confidence: `high`)
- **Headline:** Do not transact — this wallet is sanctioned on OFAC SDN and Garantex lists.
- **Reasoning:** The sanctions check returned a confirmed match against two programs (OFAC SDN and Garantex) with a high risk level, which is an automatic hard veto regardless of other signals. No mitigating positive labels, ENS, or exchange attestations exist, and web sentiment returned no offsetting evidence. Sending funds to this address would likely violate sanctions law and expose the sender to severe legal and financial risk.
- **Coverage:** resolved=[sanctions, labels, onchain_history, web_sentiment, contract_analysis] unresolved=[—]

## Notes

- Raw responses for each address are saved under `docs/real-wallet-tests/runs_v3/`.
- `partial` verdict means the route returned `insufficient_data` instead of the expected verdict — that's a more conservative miss than `safe_to_transact` when we expected `do_not_transact` (or vice versa).

---

## TL;DR — final-stretch validation

**Result: 2/2 strict-match verdicts, both `high` confidence. Zero rate-limit hits, zero `spending_limit_exceeded`. Total spend $0.0293 across 2 addresses.**

This run validated the two changes since v2:
1. **Fresh Agnic API key with a larger daily cap** — confirmed by zero `spending_limit_exceeded` errors and a healthy pre-flight `creditBalance` of $45.67.
2. **Pattern-adapter trim (5 → 1 fallback body shape)** — confirmed by no regression in LLM-adapter usage (actually *dropped* 45% → 30%) and no upstream rate-limit fallout.

## Comparison vs v2

| Metric | v2 | v3 | Notes |
|---|---|---|---|
| Verdict accuracy (strict) | 3/5 (60%) | 2/2 (100%) | v2 had 2 budget-cap regressions; v3 had none |
| Confidence on safe address | medium | **high** | Coinbase 1 got contract_analysis + onchain_history + web_sentiment all resolved |
| Confidence on bad address | high (Lazarus); low (Tornado, error) | **high** (Garantex) | Garantex got 5/5 service resolution including OFAC sanctions match |
| Primary-pick reliability | 40% | **80%** | Health-store rerank (Chunk 2) likely informed by v1/v2 failure history |
| LLM-adapter usage | 45% | **30%** | Shape trim did NOT hurt — primary shape worked more often |
| Rate-limit hits | 5+ (cascade) | **0** | New key + trim worked as designed |
| `spending_limit_exceeded` | yes (mid-run cascade) | **none** | New key |
| Spend per address | ~$0.005 (cut short) | $0.0147 (full coverage) | Higher because more services completed, not because of waste |

## Notable wins

- **orbisapi smart-contract-auditor** went from 0/3 (v2) → 2/2 (v3) — 100% success rate. The primary `{address, chain}` shape worked first try on both wallets. Confirms the trim was not removing the *useful* fallback shapes; the 5 extra alternates we removed were dead weight.
- **Garantex contract_analysis resolved** — first time we've seen `contract_analysis` resolve for an OFAC-sanctioned EOA in any run.
- **blockrun.ai web_sentiment via LLM adapter** — both wallets had their web_sentiment call routed through the LLM adapter and both came back `fallback_ok` with usable data. The LLM-fallback path is healthy.

## Single recurring hard error (config, not algorithm)

| Service | Category | Error | Frequency |
|---|---|---|---|
| `https://orbisapi.com/proxy/wallet-cluster-score-api-32f2cb/bulk` | `labels` | `Payment exceeds maximum allowed value` | v1, v2, v3 — every run |

This service consistently prices above our per-call `maxValueUsd` cap. **Not a retry or throttle issue.** Either the labels rerank should de-prioritize it, or we bump the cap for `labels` specifically. See recommendation #1 below.

## Final-stretch recommendations

Ordered by ROI (highest impact first, lowest effort first):

### 1. De-prioritize / cap-aware rerank for `labels` (high ROI, ~1h)

`orbisapi/wallet-cluster-score-api-32f2cb/bulk` has thrown `Payment exceeds maximum allowed value` in **every** run. We're wasting a rerank slot on it. Two paths:
- **Cheap fix:** in the health-store rerank, treat `payment_exceeds_max` as a *durable* signal (same weight as a domain-level error) so the service drops off the primary pick.
- **Better fix:** read `info.price` (if exposed by the catalog) at rerank time and skip services whose price > our category `maxValueUsd`. Avoids the paid call entirely.

### 2. Pre-flight `creditBalance` check in `/verify-agent` (medium ROI, ~30min)

Before kicking off the DAG, call `GET /api/balance?network=base` (non-paid, free) and short-circuit with `HTTP 503 budget_exhausted` if `creditBalance < $0.10`. Prevents the v2-style mid-run cascade entirely. Already have the curl recipe in `CLAUDE.md`.

### 3. Surface `spending_limit_exceeded` as a distinct outcome (low ROI, ~20min)

Currently bundled into `hard_errors` in the metrics. Add an outcome category so the resilience layer (Chunk 1) emits a clearer stub verdict ("Service temporarily unavailable, retry in 24h") vs the current generic "manual review required". Pure observability win.

### 4. Health-store rerank attribution log (low ROI, ~15min)

The v3 primary-pick reliability jumped to 80% — could be Chunk 2 working, could be wallet-mix variance. Log a one-line note per service pick (`[rerank] picked X over Y because health_score=0.9 vs 0.3`) so we can attribute future improvements.

### 5. (Stretch) OPTIONS / metadata probe before paid call

For consistently-failing upstreams (orbisapi wallet-cluster), a free `OPTIONS` probe or catalog-info check before the paid call would let us skip dead services entirely. Only worth doing if recommendation #1 doesn't fully solve the problem.

## What I'd ship today

If we're calling this the final stretch, **ship recommendation #1 and #2** — both are short, both materially reduce hard-error rate and budget-cascade risk, and both are testable with the existing harness. #3 and #4 are nice-to-haves for the next iteration.

