# latency-shape-fast-tier-denylist

## What

Fixes the "always ~10s" latency by changing the *shape* of the service (not by
pivoting to a self-trained model). Adds (1) a two-tier verify — a free, sub-second
sanctions gate vs the full paid pipeline; (2) a `$0` OFAC-warmed sanctioned
denylist for instant known-bad blocks; (3) an async/early-return MCP surface; and
(4) a tiered UI with an opt-in deep check. The KPI shifts from
*time-to-final-verdict* to *time-to-actionable-signal* (<1s for the common case).

## How it works

- **Two tiers** (`src/agent/verify.ts`): `VerifyAgentOpts.depth`.
  - `"fast"` → runs only the denylist + Chainalysis oracle, then returns a
    `fastSignal` of `block` (sanctioned), `proceed` (cached-safe verdict hit), or
    `needs_deep_check` (no blocking signal). **Never spends USDC.** Returns before
    discovery / x402 / synthesis.
  - `"deep"` (default) → unchanged full pipeline.
  - `VerifyAgentResult` gained `tier` and `fastSignal` (always set).
- **Sanctioned denylist** (`src/agent/sanctioned_denylist.ts`): long-TTL (72h)
  Deno KV store, separate from the verdict cache (whose `do_not_transact` TTL is
  only 5 min and would expire warmed entries). Checked at the top of `verifyAgent`
  before the oracle; a hit returns a deterministic `do_not_transact` in one KV
  read at `$0`. A miss falls through to the live oracle, so correctness never
  depends on it being warm.
- **OFAC source** (`src/agent/ofac_list.ts`): fetches the live OFAC SDN ETH list
  from the nightly-updated `0xB10C/ofac-sanctioned-digital-currency-addresses`
  mirror; falls back to the checked-in `data/sanctioned_seeds.json` on any error.
- **Warm cron** (`src/vetter/run.ts#warmSanctionedDenylist` + `scripts/warm-denylist.ts`):
  pulls the OFAC list and writes each address to the denylist KV. `$0` (no x402,
  no LLM, and no RPC unless `DENYLIST_CROSS_CHECK=1`). Bounded by `|OFAC list|`
  (~93 ETH addresses today); TTL is the GC — each run re-asserts the current set,
  de-listed addresses age out. Wired as a step in `.github/workflows/vetter.yml`.
- **Async MCP** (`src/mcp/server.ts`): `verify_wallet` gained `depth` (default
  `fast`) and, on a `needs_deep_check` result, returns a `deepCheckToken`. New
  `get_deep_verdict` tool runs the paid deep check from that token. Both tools
  exposed via the shared factory on both transports.
- **Tiered UI** (`web/`): "Fast Check · $0" button (`InputForm`), a `fast · $0`
  badge + opt-in "Run deep check · ~$0.03" CTA on the verdict card
  (`VerdictCard`), and a `depth`-aware `streamVerify` (`api.ts`).

## Files

Added:
- `src/agent/sanctioned_denylist.ts`, `src/agent/ofac_list.ts`
- `data/sanctioned_seeds.json`, `scripts/warm-denylist.ts`
- `src/agent/sanctioned_denylist_test.ts`, `src/agent/fast_tier_test.ts`,
  `src/agent/ofac_list_test.ts`, `src/mcp/server_test.ts`,
  `src/vetter/warm_denylist_test.ts`

Changed:
- `src/agent/verify.ts` (depth, fast tier, denylist check, tier/fastSignal)
- `src/vetter/run.ts` (`warmSanctionedDenylist`)
- `src/routes/verify_agent.ts`, `src/routes/verify_agent_stream.ts` (depth param,
  surface tier/fastSignal, thread denylist)
- `src/main.ts` (open + wire denylist KV), `src/mcp/http.ts`, `src/mcp/server.ts`
- `.github/workflows/vetter.yml`, `deno.json` (`warm:denylist` task)
- `web/src/types.ts`, `web/src/api.ts`, `web/src/App.tsx`,
  `web/src/components/InputForm.tsx`, `web/src/components/VerdictCard.tsx`

## Config

- `DENO_KV_CONNECT_URL` + `DENO_KV_ACCESS_TOKEN` (workflow secrets): KV Connect
  target so the GitHub Actions cron writes the **production** (Deno Deploy) KV.
  When unset, the warm step writes a throwaway local KV (fine for local/dev).
- `DENYLIST_CROSS_CHECK=1` (optional): confirm each OFAC address via the on-chain
  oracle before writing. Off by default (avoids RPC rate-limit fan-out).

## Notes / gaps

- **Backward compatible:** `depth` defaults to `deep` everywhere on the HTTP
  surface, so the historical single-tier `/verify-agent` contract is unchanged.
  MCP `verify_wallet` defaults to `fast` (it's the agent-facing surface and the
  whole point is fast-first).
- **No cassette re-record** — fast tier makes no x402 calls and deep tier uses the
  same recipes; request shapes are unchanged (replay stays 9/9).
- **Cross-environment KV caveat:** verdict reads happen inside the Deno Deploy
  service KV; the cron runs in GitHub Actions, so it must use KV Connect (above)
  to populate the same KV. Without the secrets the prod denylist stays cold — but
  the live oracle still blocks sanctioned addresses, so this is a latency
  optimization, not a correctness dependency.
- **Deferred (future plan):** warming *paid* clean-address deep verdicts (the
  traffic-bounded, real-USDC half) — reuses this cron scaffolding, gated on a
  query-frequency hot-set + per-run budget cap + forced-Haiku synthesis.
