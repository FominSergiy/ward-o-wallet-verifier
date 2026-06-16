# On-chain graph risk model — implementation plan

**Why this exists:** WARD-o today generates zero proprietary risk signal — it is
a third-party data orchestrator + LLM synthesis layer (Chainalysis oracle, ENS,
eth-labels.com, discovered x402 vendors). This plan builds the one thing that
would make the product defensible: a risk model trained on on-chain transaction
graph features, served as a WARD-o chain primitive (and optionally a paid x402
service). The moat is not the initial model — it is the feedback flywheel
(every verify query → new inference data → better labels → retrain).

**Strategy:** Build a **tabular feature model first** (XGBoost on per-address
statistics), then add **graph neighborhood features** (Phase 8) as the real
differentiator. Skip GNN until tabular + 1-hop is proven. The bottleneck is not
the model — it is archive-depth transaction history per address.

**What already exists that reduces the work:**
- `src/agent/labels_registry.ts` — eth-labels.com, ~170k labeled addresses (label seed)
- `src/agent/sanctions_oracle.ts` — Chainalysis OFAC boolean (hardest negative labels)
- `src/agent/onchain_viem.ts` — txCount/balance/currentBlock fetch (start of feature vector)
- `src/discovery/health_store.ts` — feedback plumbing to extend for verdict capture
- `src/agent/synthesize_verdict.ts` — keyword heuristics the model augments; prompt is the spec
- `src/discovery/deterministic_sources.ts` — pattern for registering a new always-on free check

Items are sequential (each builds on the prior). Sizes assume fully-agentic solo dev.

---

## Phase 1 — Label dataset curation  (S · ~3 days)

**What:** Pull and merge all known labeled addresses into a single training set.

**Sources to combine:**
- eth-labels.com registry (already integrated, ~170k entries)
- OFAC SDN list (public XML download → parse to addresses)
- Tornado Cash depositors (public Dune query, ~100k addresses)
- Scam databases (cryptoscamdb.network JSON feed, forta-network datasets)
- Exchange hot wallets (supplement eth-labels from community lists)

**Files:**
- `data/labels.csv` — new: `address, chain, risk_class` where risk_class ∈
  {sanctions, mixer, scam, exchange, protocol, unknown}
- `scripts/build_labels.ts` — new: download + parse + dedup + merge

**Acceptance criteria:**
- `data/labels.csv` exists with ≥150k rows, deduplicated by (address, chain).
- All six risk_class values present; class distribution printed to stdout.
- Re-running the script is idempotent (same input → same output, no dupes).

**Validation:** `~/.deno/bin/deno run --allow-net --allow-read --allow-write scripts/build_labels.ts && wc -l data/labels.csv`

**Test spec (`scripts/build_labels_test.ts`):**
- `parses OFAC SDN XML into a flat address list`
- `normalizes mixed-case addresses to lowercase before dedup`
- `merges two sources with overlapping addresses without duplicate rows`
- `assigns risk_class deterministically when an address appears in multiple sources (priority: sanctions > mixer > scam > exchange > protocol)`

**Blocker:** Class imbalance — eth-labels skews to exchanges/protocols (safe).
Without Tornado/scam data you get ~170k safe vs ~5-10k risky. Validate the
distribution before training; plan for class weights in Phase 4.

---

## Phase 2 — Transaction history ingestion  (M · ~5-7 days)

**What:** For every labeled address, fetch full tx history and store locally.

**Data source choice:**
- **Dune Analytics** for the one-time training batch (free tier, SQL, 1-5 min
  latency — fine for batch, unusable for real-time).
- **Alchemy/QuickNode** (`alchemy_getAssetTransfers`) for real-time inference
  in Phase 5 (~$50-200/mo, ~300 req/s).

**Files:**
- `data/tx_history/` — new: DuckDB table or per-address JSON (raw tx list)
- `scripts/ingest_history.ts` — new: batched fetch + retry + cost tracking
- `.env.example` — add `ALCHEMY_API_KEY`, `DUNE_API_KEY`

**Acceptance criteria:**
- Tx history present for ≥95% of labeled addresses (some dead addresses expected).
- Ingestion resumes from checkpoint after interruption (no full re-fetch).
- Per-run cost + call count logged to stdout.

**Validation:** `~/.deno/bin/deno run --allow-net --allow-read --allow-write --allow-env scripts/ingest_history.ts --limit 100`

**Test spec (`scripts/ingest_history_test.ts`):**
- `respects rate limit (no more than N concurrent requests)`
- `retries on 429 with backoff and eventually succeeds`
- `skips addresses already present in the checkpoint`
- `handles an address with zero transactions without erroring`

**Blocker:** Archive API cost + rate limits. Budget ~$30-80 for the training
batch. This is the highest cost/complexity risk in the plan.

---

## Phase 3 — Feature engineering  (M · ~5-7 days)

**What:** Transform raw tx history into a flat feature vector per address.

**Feature set:**
```
Basic counts:    tx_count, tx_count_in, tx_count_out
Value stats:     total_volume_eth, avg_tx_value, std_tx_value, max_single_tx
Age signals:     wallet_age_days, days_since_last_tx, tx_frequency_per_day
Counterparty:    unique_senders, unique_receivers, fan_in_ratio
Mixer proximity: direct_tornado_interaction (bool)
CEX interaction: received_from_known_cex (bool), sent_to_known_cex (bool)
Pattern:         roundtrip_ratio, burst_score (max_tx_in_24h)
Balance:         current_balance_eth, balance_to_volume_ratio
```
`fan_in_ratio` and `roundtrip_ratio` are the strongest non-label signals for
mixers/scams.

**Files:**
- `scripts/build_features.ts` — new: raw tx → feature vector
- `data/features.parquet` (or DuckDB table) — new: address → features
- `src/graph/features.ts` — new: shared feature-computation module (reused at
  inference time in Phase 5)

**Acceptance criteria:**
- `data/features.parquet` has one row per ingested address, all features non-null
  (sane defaults for zero-tx addresses).
- `src/graph/features.ts` exports a pure `computeFeatures(txList) → FeatureVector`
  usable by both the batch script and the inference API.

**Validation:** `~/.deno/bin/deno check src/graph/features.ts && ~/.deno/bin/deno test src/graph/features_test.ts`

**Test spec (`src/graph/features_test.ts`):**
- `computes fan_in_ratio correctly for a known tx list`
- `roundtrip_ratio detects matched in/out amounts within ±5%`
- `flags direct_tornado_interaction when a known mixer address appears`
- `returns zero-valued feature vector for an address with no transactions`
- `burst_score reflects the max transactions in any 24h window`

**Blocker:** Feature selection is a judgment call; the code is highly agentic.

---

## Phase 4 — Model training pipeline  (S · ~3 days)

**What:** Train, evaluate, persist an XGBoost classifier. No GNN at this stage.

**Files:**
- `scripts/train_model.py` (or ONNX-export Deno wrapper) — new
- `data/model.json` — new: XGBoost native model
- `data/feature_names.json` — new: ordered feature list for inference parity
- `docs/research/model-eval-v1.md` — new: metrics report

**Acceptance criteria:**
- Multiclass model {safe, mixer, scam, sanctions, exchange, unknown} trained on
  a 70/15/15 stratified split.
- Per-class precision/recall/F1 + AUROC written to the eval report.
- `scale_pos_weight` / class weights applied; minority-class recall reported
  honestly (expected low on scam).
- Model + feature_names persisted and loadable.

**Validation:** run the training script end-to-end; assert eval report exists
with all six classes scored.

**Test spec (`scripts/train_model_test`):**
- `train/val/test split is stratified (class ratios preserved within 2%)`
- `feature_names.json order matches the training matrix column order`
- `persisted model reloads and produces identical predictions on a fixture row`
- `eval report contains precision/recall/F1 for every class`

**Blocker:** Model quality is capped by label quality. 85-90% on known labeled
data is the realistic ceiling; novel scam recall will be low.

---

## Phase 5 — Inference API  (S · ~3 days)

**What:** REST endpoint: address → live feature compute → model predict → score.

**Inference path:** cache check (TTL 24h or until txCount changes) → Alchemy
archive fetch → `computeFeatures` (reused from Phase 3) → XGBoost predict →
cache + return.

**Files:**
- `src/graph/scorer.ts` — new: load model, run prediction
- `src/routes/graph_score.ts` — new: `POST /graph-score`
- `src/main.ts` — mount the route
- `data/score_cache` — DuckDB/SQLite cache table

**Acceptance criteria:**
- `POST /graph-score {address, chain}` → `{risk_score, risk_class, confidence, features}`.
- Cache hit returns in <50ms; cache miss completes within Alchemy latency (~0.5-2s).
- Cache invalidates when the address's txCount changes.

**Validation:** `~/.deno/bin/deno check src/graph/scorer.ts src/routes/graph_score.ts && ~/.deno/bin/deno test src/routes/graph_score_test.ts`

**Test spec (`src/routes/graph_score_test.ts`):**
- `returns a score for a known address (model + features stubbed)`
- `serves from cache on the second identical request (no second Alchemy call)`
- `recomputes when txCount has changed since the cached entry`
- `returns 400 for a malformed address`
- `degrades gracefully (503) when the model file is missing`

---

## Phase 6 — WARD-o integration as chain primitive  (S · ~2 days)

**What:** Wire the graph scorer into the verify pipeline as an always-on free
check alongside the Chainalysis oracle and ENS.

**Files:**
- `src/agent/graph_scorer.ts` — new: thin HTTP client to `/graph-score`
- `src/agent/invoke_all.ts` — call the scorer in the deterministic-sources fanout
- `src/discovery/deterministic_sources.ts` — add graph score to the free-checks list
- `src/agent/synthesize_verdict.ts` — add a weighting rule for `findings.graph_score`
- `web/src/categoryLabels.ts` — tooltip label

**Acceptance criteria:**
- `/verify-agent` findings include `graph_score` with class + score.
- Synthesis prompt treats a high-confidence mixer/scam graph score as a strong
  negative (mirroring the Chainalysis oracle hard-veto pattern, but as a strong
  bias not an absolute veto).
- PlanCard "Always-on free checks" lists the graph model at $0.

**Validation:** `~/.deno/bin/deno check src/agent/graph_scorer.ts && ~/.deno/bin/deno test src/agent/invoke_all_test.ts src/agent/synthesize_verdict_test.ts`

**Test spec:**
- `invoke_all emits a graph_score finding when the scorer resolves`
- `invoke_all tolerates a graph scorer failure without aborting the pipeline`
- `synthesize_verdict biases unsafe when graph_score.risk_class is "scam" high-confidence`
- `synthesize_verdict treats graph_score "safe" as supporting, not overriding, evidence`

---

## Phase 7 — Feedback loop for continuous retraining  (M · ~5-7 days)

**What:** Capture every WalletVerdict, store it, promote high-confidence verdicts
to new training labels, retrain **manually** when you feel like it. Promotion is
a human decision, not an automated gate — at solo-dev cadence you ARE the gate,
and reading two numbers off an eval report is a better, lower-overhead check than
an unsupervised threshold you'd have to tune and babysit.

**Confirmed-label heuristic:** high-confidence `do_not_transact` where the
Chainalysis oracle also flagged → confirmed negative. High-confidence
`safe_to_transact` with ENS + exchange label + oracle clean → confirmed positive.
Ignore the ambiguous middle.

**Files:**
- `data/verdicts.db` — new: verdict capture table
- `src/agent/verify.ts` — persist each verdict (fire-and-forget)
- `scripts/promote_labels.ts` — new: verdicts → new label rows
- `scripts/retrain.ts` — new: merge new labels, retrain, write a **versioned** artifact
- `scripts/eval_report.ts` — new: score a candidate model and PRINT the deltas (no auto-decision)
- `data/model.live.json` — new: pointer file naming the currently-live model version

**Acceptance criteria:**
- Every `/verify-agent` call appends a row to `verdicts.db` (non-blocking).
- `promote_labels.ts` emits only verdicts meeting the confirmed-label heuristic.
- `retrain.ts` produces a versioned artifact (`model-vN.json`), never overwriting the live one.
- `eval_report.ts` scores the candidate against the held-out test set **and** the
  real-wallet fixtures, and prints: overall F1 delta vs live, per-class recall
  delta, and any fixture verdict that flipped. It makes no promotion decision —
  the human reads it and decides.
- Promotion is a one-line manual step: repoint `model.live.json` to the new
  version. Rollback is the same step in reverse — no code deploy either way.

**Validation:** `~/.deno/bin/deno test scripts/promote_labels_test.ts scripts/eval_report_test.ts`

**Test spec (`scripts/promote_labels_test.ts`):**
- `promotes a do_not_transact verdict only when the oracle also flagged`
- `promotes a safe verdict only with ENS + exchange label + oracle clean`
- `excludes medium/low-confidence verdicts`
- `does not double-count an address already in the label set`

**Test spec (`scripts/eval_report_test.ts`):**
- `reports the F1 delta between candidate and live model`
- `reports per-class recall deltas`
- `flags any real-wallet fixture whose verdict changed`
- `runs as a pure read-only report and never mutates model.live.json`

**Blocker:** "What counts as a confirmed label" is a human judgment encoded once.

**Deliberately deferred until retrain cadence justifies it (NOT built now):**
- *Automated promotion gate* — a cron that retrains and auto-flips the live
  pointer on threshold rules. Only worth it once manually reviewing each retrain
  is the bottleneck; at solo-dev volume that's months away or never. Until then
  the manual flip + eval report is strictly less overhead and a better check.
- *Drift detection, feature-null-rate monitors, eval-set-staleness refresh* —
  matter at real traffic volume; building them now is scope creep.

The static eval set + print-the-delta report + manual flip is the low-maintenance
design: once written it needs no attention unless a retrain visibly regresses,
and there are no thresholds to tune.

---

## Phase 8 — Graph neighborhood features (the real differentiator)  (L · ~10-15 days)

**What:** Extend the feature vector with 1-hop counterparty statistics — instead
of "interacts with Tornado directly," compute "what fraction of counterparties
show mixer-like fan_in/roundtrip patterns." Catches scammers whose own address
is still clean but whose counterparties are not.

**Files:**
- `src/graph/neighborhood.ts` — new: fetch + aggregate 1-hop counterparty features
- `src/graph/features.ts` — extend feature vector with neighborhood aggregates
- `scripts/build_features.ts` — recompute training features at 1-hop depth
- retrain (Phase 4) on the expanded feature set

**Acceptance criteria:**
- Feature vector gains neighborhood aggregates (mean/max counterparty fan_in_ratio,
  fraction_risky_counterparties, hops_to_nearest_mixer ≤2).
- Per-query Alchemy cost stays within a configured ceiling via batching + cache.
- Eval shows improved scam/mixer recall vs the Phase 4 tabular-only baseline.

**Validation:** `~/.deno/bin/deno test src/graph/neighborhood_test.ts` + retrain eval delta report.

**Test spec (`src/graph/neighborhood_test.ts`):**
- `aggregates counterparty features for a fixture 1-hop graph`
- `caps the number of counterparties fetched per query at the configured limit`
- `serves counterparty features from cache on repeat queries`
- `computes fraction_risky_counterparties against the labeled set`

**Blocker:** Cost (~$0.01-0.05/query at 1-hop) + query performance. Schedule once
Phase 5 is live and generating volume to justify the Alchemy spend.

---

## Summary

| Phase | Feature | Size | Days |
|-------|---------|------|------|
| 1 | Label dataset curation | S | 3 |
| 2 | Tx history ingestion | M | 5-7 |
| 3 | Feature engineering | M | 5-7 |
| 4 | Model training pipeline | S | 3 |
| 5 | Inference API | S | 3 |
| 6 | WARD-o integration | S | 2 |
| 7 | Feedback loop | M | 5-7 |
| 8 | Graph neighborhood features | L | 10-15 |

- **To MVP (Phases 1-6):** ~3.5 weeks agentic
- **To defensible moat (+ 7-8):** ~6-7 weeks total

**Honest caveats:**
1. Data cost is real — training batch ~$30-80; real-time 1-hop inference ~$0.01-0.05/query.
2. Label quality is the ceiling — strong on OFAC/mixers, weak on novel scams until feedback accrues.
3. The moat is the feedback flywheel, not the initial model.
4. Phase 8 is what makes it novel; Phases 1-6 only beat keyword heuristics.
