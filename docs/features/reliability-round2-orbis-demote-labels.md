# reliability-round2-orbis-demote-labels

**What:** Demotes the wholesale-dead orbisapi.com provider (one-time prod DB
block + permanent discovery/selection denylist) and makes the free eth-labels.com
registry a first-class direct source so the `labels` category keeps a flow-diagram
node and a receipt now that no paid labels x402 service exists.

## Files

**Ticket A1 — prod DB sweep (no code):** blocked the 8 selectable `orbisapi.com`
rows (4 onchain_history + 4 sanctions, all probation) in prod Neon
(`super-grass-68246474`) via `UPDATE service_registry SET status='blocked'
WHERE resource ILIKE '%orbisapi.com%' AND status IN ('active','probation')`.
Post-state: 0 orbis selectable; labels 0 active / 5 blocked; web_sentiment 0/2.

**Ticket A2 — host denylist (code):**
- `src/discovery/host_denylist.ts` (new) — `getDeniedHosts()` /
  `isDeniedHost()`, reads `DISCOVERY_HOST_DENYLIST` (default `orbisapi.com`),
  case-insensitive substring match.
- `src/vetter/run.ts` — discovery-insert loop skips denied hosts (logs
  `skipping denied host`), next to the existing `isLikelyInvokableEndpoint` filter.
- `src/registry/select.ts` — defensive skip of denied hosts, **scoped to the
  production DB branch only** (the offline recipe branch is a frozen replay
  fixture that must keep mirroring the cassettes — which still include orbis).
- Tests: `src/discovery/host_denylist_test.ts` (new),
  `src/vetter/run_test.ts` (+2), `src/registry/select_test.ts` (+1).

**Ticket B — eth-labels as a direct source (code):**
- `src/agent/verify.ts` — new `fetchLabelsWithEvents()` wraps the eth-labels call
  mirroring `resolveEnsWithEvents`: emits `service` start + ok/error events
  (`resource:"eth-labels://eth"`, `category:"labels"`, `kind:"direct"`) and
  returns a synthetic `ServiceInvocationOutcome` (`paid:false`, `amountUsdc:0`)
  pushed into `invocation.outcomes` unconditionally so labels has a receipt +
  diagram node even with no paid service. Findings-merge logic unchanged.
- Tests: `src/agent/verify_test.ts` (+2; one existing receipt-count assertion
  updated 1→2), `src/agent/verdict_cache_test.ts` (receipt-count assertion 1→2,
  made offline with a labels hook).

## Config

- **`DISCOVERY_HOST_DENYLIST`** (new, optional) — comma-separated host
  substrings; default `orbisapi.com`. Env-overridable so a host can be
  re-enabled without a code change if it turns x402 back on.

## Notes

- **No cassette re-record.** B adds an outcome but no new HTTP call. A2's
  selection skip is DB-path-only, so the offline replay set is unchanged.
  Initial attempt filtered in both branches and broke replay (the cassettes
  include an orbis web_sentiment service) — the fix was to scope the filter to
  the production DB path.
- The frontend already renders `kind:"direct"` events as nodes
  (`useFlowState.ts` / `FlowDiagram.tsx`), so B makes the labels node reappear
  with no frontend code. The remaining frontend sweep is Ticket C (separate PR).
- Validation: full offline suite 391 pass / 0 fail / 12 ignored, replay 9/9,
  `deno task check` + `deno task lint` clean.
- **Deferred (Ticket D, operator-deferred):** viem free public RPCs fail from
  Deno Deploy egress → onchain_history only resolves when paid ottoai is alive.
  Fix is env-only (`RPC_URL_ETH`/`RPC_URL_BASE` keyed provider); no code change.
