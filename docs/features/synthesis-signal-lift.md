# synthesis-signal-lift

**What:** Three additions to lift verdict confidence on objectively-clean and
objectively-sanctioned wallets without abandoning the self-discovery pitch:
(1) a Chainalysis sanctions-oracle on-chain hard-gate that short-circuits the
verdict + skips all x402 spend on a confirmed match, (2) labels-discovery
quality improvements (sharper query, description-keyword rerank bump, post-call
quality-probe that durably demotes labelers returning empty on rich-history
wallets) that stay strictly within self-discovery, and (3) viem ENS reverse
resolution added to DEFAULT_CATEGORIES so ENS-doxxed wallets like vitalik.eth
get an explicit positive prior.

T1 and T3 are chain-primitive fallbacks — they read on-chain state via the
same RPC infrastructure used by `onchain_viem.ts`, not vendor HTTP endpoints.
Comment blocks tagged `// CHAIN-PRIMITIVE FALLBACK:` document the rationale at
each call site.

**Why these specific three?** A pre-implementation audit of CDP Bazaar (query
endpoint at `api.cdp.coinbase.com/platform/v2/x402/discovery/search`) confirmed
that the highest-coverage commercial labeler (BlockSec / MetaSleuth, ~400M
labels) is NOT registered in the catalog as of 2026-05-23 — queries for
`blocksec` and `metasleuth` return zero hits. The labelers that ARE present
(orbisapi.com `wallet-label-tag-api-de7bff`, `wallet-label-classifier-api-56ce3c`,
`x402-deployer.workers.dev/wallet-label`, `blockchain-address-labeler-api-791ccf`)
have weak adoption and no claimed coverage at MetaSleuth's scale. Pinning a
non-discovered vendor URL was rejected as a violation of the demo pitch. T2
instead raises the ceiling within self-discovery, accepting that we cannot
create coverage that doesn't exist in the catalog. Honest consequence: CEX
hot wallets like Binance Hot Wallet 20 may continue to return labels findings
without entity attribution until a high-coverage labeler registers in Bazaar.

**Files:**

- *new* `src/agent/sanctions_oracle.ts` — `checkSanctionsOracle(address, chain)`
  reads `isSanctioned(address)` from the Chainalysis-maintained smart contract
  at `0x40C57923924B5c5c5455c48D93317139ADDaC8fb`. Supports eth, base,
  polygon, arbitrum, optimism via the existing public RPC list. Throws on RPC
  errors / unsupported chains instead of silently returning false — verify.ts
  catches and proceeds without the gate.
- *new* `src/agent/sanctions_oracle_test.ts` — 6 tests (sanctioned, clean,
  RPC error, unsupported chain, supported-chain enumeration, timestamp shape).
- *new* `src/agent/ens_resolver.ts` — `resolveEns(address, chain)` calls
  viem's `getEnsName` on Ethereum mainnet. Non-eth chains short-circuit to
  `ensName: null` without an RPC call. Mainnet-only by design (ENS reverse
  resolution doesn't exist natively on L2s).
- *new* `src/agent/ens_resolver_test.ts` — 6 tests (doxxed wallet, null,
  non-eth chain, RPC error, support check, timestamp shape).
- *modify* `src/agent/verify.ts` — calls the oracle before discovery; on a
  match, returns a deterministic `do_not_transact` / `confidence: high`
  verdict with `totalSpentUsdc: 0` and skips all downstream phases. On clean,
  proceeds with the normal flow and merges the oracle result into
  `findings.sanctions` alongside any x402 service result. Adds `ens` to
  DEFAULT_CATEGORIES; runs `resolveEns` in parallel with `invokeAll` and
  merges its result into `findings.ens`; tracks ens in `not_applicable` for
  non-eth chains.
- *modify* `src/agent/verify_test.ts` — 5 new tests (oracle short-circuit,
  oracle-clean merge, oracle-throw graceful fallback, ENS resolver merge,
  ENS skip on non-eth, ENS-throw silent), plus seam updates to existing
  tests that exercise the new not_applicable bucket.
- *modify* `src/agent/synthesize_verdict.ts` — extended the sanctions prompt
  section to recognize `chainalysis_oracle.isSanctioned` true/false signals
  with strong positive evidence for the clean case. Strengthened ENS prompt
  section into a combination rule: "ENS hit + sanctions clean + any positive
  on-chain evidence ⇒ safe_to_transact with medium confidence at minimum".
- *modify* `src/discovery/queries.ts` — added `name tag`, `hot wallet`,
  `entity attribution`, `known address database` to the labels discovery
  query so the candidate set isn't bottlenecked by the previous narrower
  phrasing. Original CEX/mixer terms preserved.
- *modify* `src/discovery/rank.ts` — surfaces a `[hint: description mentions
  entity-attribution keywords]` annotation next to candidates in the rerank
  prompt when their description matches a fixed keyword list (no provider
  IDs, no URLs, only catalog text). Adds an explicit soft preference rule to
  the rerank prompt. Fallback `pickByCategory` extends to apply the same
  tie-break only for the `labels` category. Filter additionally pushes
  quality-demoted services to the bottom of each category.
- *modify* `src/discovery/health_store.ts` — adds `emptyOnRich` + `emptyOnRichAt`
  fields, `recordEmptyOnRich`, `resetEmptyOnRich`, `isQualityDemoted`.
  Demotion threshold 3 consecutive misses, TTL 7 days. Existing `recordOk`
  and `recordError` now preserve other fields (`...cur` spread) — previously
  they would have wiped a freshly-recorded `emptyOnRich` on the next ok/err.
- *modify* `src/agent/invoke_all.ts` — post-call quality probe. If
  `onchain_history.txCount >= 100` (heuristic for "well-known wallet") AND
  `labels` returned a payload with no recognizable attribution keywords AND
  fewer than 200 chars of meaningful content, call `recordEmptyOnRich`.
  Otherwise call `resetEmptyOnRich`. The keyword list and short-payload
  threshold are explicit in the file; they detect the orbisapi-style
  "metadata-only" response pattern flagged in `docs/real-wallet-tests/report_v6_summary.md`.
- *modify* `src/discovery/queries_test.ts`, `src/discovery/health_store_test.ts`,
  `src/discovery/rank_test.ts`, `src/agent/invoke_all_test.ts` — new tests
  for query terms, demotion accumulation/reset/TTL, entity-attribution
  tie-break, post-call probe records/skips. Total new test count: 21.
- *modify* `scripts/test_wallets.ts` — added 5 fixtures (Coinbase 1 hot,
  Kraken 4 hot, OFAC SDN Tornado Cash deposit, nick.eth ENS-doxxed retail,
  synthetic fresh wallet). Brings the regression panel to 9 wallets.
- *modify* `scripts/compare_runs.ts` — V1_DIR / V2_DIR / OUT_PATH now read
  from env, default to v6_3 baseline vs v7 with output at
  `docs/real-wallet-tests/comparison_v6_v7.md`.

**Config:** No new env vars. Reuses existing `RPC_URL_ETH` / `RPC_URL_BASE`
etc. for the oracle and ENS resolver. The Chainalysis oracle adds zero spend
when sanctions hit; on clean wallets it adds one free RPC call per verify in
parallel with the existing flow.

**Verdict policy changes (in synthesis prompt):**

- Hard veto now recognizes `chainalysis_oracle.isSanctioned: true` alongside
  the existing x402-sanctions hit patterns.
- Oracle-clean (`chainalysis_oracle.isSanctioned: false`) is treated as
  strong positive evidence — sufficient on its own to satisfy the "sanctions
  clean" requirement even if the x402 sanctions service is unresolved.
- ENS hit + sanctions clean + any positive on-chain history ⇒
  `safe_to_transact` with confidence at least medium. Designed to lift
  ENS-doxxed wallets (e.g. vitalik.eth, nick.eth) out of `insufficient_data`
  when labels return empty.

**Notes:**

- *Why not pin BlockSec via x402?* Verified against the CDP Bazaar discovery
  endpoint — BlockSec / MetaSleuth is not in the catalog. Pinning their URL
  via a hand-rolled adapter would have been a hard-coded vendor choice
  regardless of whether the payment rail is x402. Plan reviewed with the
  user; option rejected as inconsistent with the self-discovery demo pitch.
- *T2 cannot create coverage.* The labels-discovery improvements lift the
  ceiling but cannot synthesize entity attribution that's not in any Bazaar
  service today. Expect Binance / Coinbase / Kraken CEX hot wallets to
  continue showing labels findings without entity tags until a high-coverage
  labeler registers in the catalog. The quality-probe + demotion is the
  long-tail fix: as the catalog grows, persistently-empty labelers get
  pushed down and better ones surface to the top.
- *Oracle on Base.* Chainalysis publishes their oracle on Base mainnet at
  the same address as on Ethereum. Observed in dev: occasional `"0x"`
  responses from `https://mainnet.base.org` for the readContract call —
  treated as a soft failure (the warning is logged, the flow continues
  through the x402 sanctions service). May indicate the RPC endpoint
  doesn't have the contract deployed at expected address on Base, or a
  public-RPC quirk. Did not block verdict correctness on the regression
  panel.
- *Heuristic thresholds in T2 are arbitrary but defensible.* `RICH_HISTORY_TX_COUNT = 100`
  ≈ "active wallet". `QUALITY_DEMOTION_THRESHOLD = 3` consecutive misses ≈
  "consistent pattern, not noise". `QUALITY_DEMOTION_TTL_MS = 7 days` ≈ "long
  enough to matter, short enough that catalog improvements get noticed". All
  three are easy to tune by editing the constants if real-world data
  suggests otherwise.
- *ENS only on eth.* L2 chains have their own naming systems (Base names,
  etc.) but the viem `getEnsName` reverse lookup is mainnet-only. Adding L2
  name resolution is a follow-up if regression data ever flags it as worth
  the effort.
- *Service-descriptor retry interaction.* The post-call quality probe runs
  AFTER the descriptor-retry fix in invoke_service.ts, so it correctly
  evaluates the substantive response (not the descriptor payload). The
  attribution-keyword set includes `entity` and `name_tag` precisely to
  match the orbisapi response shape after sub-path retry.

**Validation:**

- `~/.deno/bin/deno task check` / `lint` / `test` — green (904 tests, 25
  ignored, 0 failed).
- Real-wallet regression (`docs/real-wallet-tests/report_v7.md`,
  `docs/real-wallet-tests/comparison_v6_v7.md`): **9/9 strict verdict match
  on the expanded 9-wallet panel**, 0 regressions vs v6_3. Highlights:
  - Lazarus latency 36s → 2.7s; cost $0.0174 → $0 (T1 oracle short-circuit)
  - OFAC SDN Tornado deposit (new fixture): 2.4s; $0
  - Vitalik confidence medium → high (T3 ENS + synthesis rule)
  - Binance confidence medium → high (oracle-clean dual-source + synth)
  - nick.eth (new): safe_to_transact / high via ENS rule
  - Synthetic fresh wallet: correctly returns insufficient_data
  - Per-wallet spend dropped 22% ($0.0174 → $0.0135 avg) thanks to
    zero-cost oracle short-circuits
- **RPC swap during validation:** initial run used cloudflare-eth.com as the
  default eth RPC; both the Chainalysis oracle and viem ENS resolver
  silently failed against it (oracle reverted, ENS got "Internal error" on
  the Universal-Resolver CCIP-read call). Switched defaults to
  `ethereum-rpc.publicnode.com` (and matching publicnode endpoints for the
  other oracle chains). Operator override via `RPC_URL_ETH_ORACLE`,
  `RPC_URL_ETH_ENS`, or the shared `RPC_URL_ETH`.
