# Service Discovery

**What:** End-to-end pipeline that detects the agnic wallet's funded network, fans out semantic searches to the CDP x402 discovery endpoint for each plan-category, then uses an LLM rerank (with quality-sort fallback) to pick one service per category. Exposed as `POST /discover` for a working callable + the e2e test target.

**Files:**
- `src/discovery/types.ts` — shared discovery types, `WalletNetwork`, error classes, `RankedSelectionSchema`
- `src/discovery/network.ts` — `detectWalletNetwork()` via `/api/balance` and `/api/balance?network=base`
- `src/discovery/client.ts` — `searchDiscovery()` wrapping `GET /platform/v2/x402/discovery/search`
- `src/discovery/queries.ts` — hand-tuned `CATEGORY_QUERIES` per non-ens category
- `src/discovery/orchestrator.ts` — `fetchCandidates()` parallel fan-out with partial-success semantics
- `src/discovery/rank.ts` — `rankServices()` LLM rerank with quality-sort fallback
- `src/discovery/discover.ts` — top-level `discover()` composing all stages
- `src/routes/discover.ts` — Hono router exposing `POST /discover`
- `src/main.ts` — mounts the router
- `src/discovery/*_test.ts` and `src/routes/discover_test.ts` — unit + e2e tests
- `plans/service-discovery.md` — the implementation plan this feature followed

**Config:** No new env vars. Reuses `AGNIC_API_KEY` for balance detection and `OPENROUTER_API_KEY` (already present) for the LLM rerank. CDP discovery endpoint is public/unauthenticated.

**Notes:**
- LLM rerank is best-effort. If the LLM provider fails (e.g. missing key, upstream error), the ranker silently falls back to picking the candidate with the highest `extensions.bazaar.quality.l30DaysUniquePayers`, tie-broken by lowest price. Both paths produce a valid `RankedService[]`.
- ENS is excluded from discovery — it stays on the free viem public-RPC path in `resolve.ts`.
- Network preference is mainnet > sepolia when both wallets are funded (real services live on mainnet).
- The discovery client filters out off-network entries (CDP occasionally co-lists Solana variants under search results).
- E2E test is gated by `RUN_E2E=1` so it doesn't hit live APIs on every `deno task test`. Run with `RUN_E2E=1 ~/.deno/bin/deno test --allow-net --allow-env src/routes/discover_test.ts`.
- The existing static category→endpoint map in `src/agent/resolve.ts` is **not yet replaced**. Treat discovery as additive for now; replacing/augmenting the resolver is a follow-up ticket.
- `totalEstimatedCostUsdc` floats can have tiny rounding error from `priceUsdc = amountMicroUsdc / 1_000_000` arithmetic. Compare with a tolerance, not strict equality.
- Live e2e on 2026-05-21 against `0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2` returned `anchor-x402.com/v1/screen` (sanctions, $0.001) and `orbisapi.com/proxy/wallet-cluster-score-api-32f2cb/analyze` (labels, $0.001) — both real and callable.
