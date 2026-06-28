# Round 2 — Demote dead orbis, make the free backbone visible, sweep the frontend

**Status:** planned · handoff to next agent
**Prereq shipped:** PR #76 (`reliability-tighten-hotpath`) is merged + live in prod.
**Author context date:** 2026-06-28. Convert "now"-relative facts by re-querying prod.

---

## Context — why this exists

Round 1 (PR #76: pessimistic scoring, persist-block, viem failover defaults,
discovery junk filter) merged and is **verified working in prod**. Two fresh
`/verify-agent` runs (`fromCache:false`) confirmed: persist-block auto-blocks dead
services, and the alternates-fallback finds working non-orbis services
(`x402.ottoai.services` resolved onchain_history; verdict came back fully
covered). The mechanism is sound.

But the operator still "sees 2 dead services every run" and noticed the **labels
node disappeared from the frontend flow diagram**. Root-caused from the prod DB +
two read-only code explorations:

1. **Upstream: the entire `orbisapi.com/proxy/*` catalog has been de-x402'd.**
   Every orbis endpoint returns `target_api_is_not_x402_enabled`. Orbis was the
   bulk of discovered services for labels / onchain_history / web_sentiment. The
   only confirmed-working non-orbis paid services (30d observations):
   `api.anchor-x402.com/v1/screen` (sanctions, 23✓/1✗) and
   `x402.ottoai.services/transaction-history` (onchain, 1✓/0✗). **This is not
   fixable in code — the provider turned off payments.** The reliable backbone is
   now the FREE deterministic sources + those two paid services.

2. **Registry backlog:** ~12 dead orbis rows still sit at `score 1.0` (round-1's
   low-insert-score only affects NEW rows). Selection picks the next one each
   run, persist-blocks it — noisy one-per-run convergence. → **Ticket A.**

3. **eth-labels is invisible.** Every free source emits a `kind:"direct"` service
   event (Chainalysis oracle, ENS, viem) **except eth-labels**, which only logs
   and merges into `findings.labels`. So when the last paid labels x402 service is
   blocked, `labels` has no diagram node and no receipt — even though
   `coverage.resolved` still includes it (verdict card shows the finding). This is
   the "labels silently disappeared" report. → **Ticket B** (fixes diagram +
   receipts in one backend change). → **Ticket C** (frontend sweep).

4. **viem (free onchain floor) fails on Deno Deploy.** Post-deploy, viem failover
   still failed across all public RPCs (`cloudflare-eth.com` "Cannot fulfill
   request") — public RPCs reject Deno Deploy datacenter egress. onchain only
   resolves when paid ottoai is alive. → **Ticket D** (open decision).

**Decisions captured from the operator:**
- Demote orbis — **approved** ("if orbis is dead - lets demote it - I am okay with
  that change").
- Frontend regression + ticket — operator asked "worth doing?" → yes, scoped here.
- viem keyed-RPC onchain floor — operator **dismissed/deferred**; do NOT block on
  it. Recommendation kept in Ticket D.

---

## Ticket A — Demote orbis (wholesale-dead provider)

A DB block alone gets re-seeded by the vetter's discovery, so two parts.

### A1 — one-time prod DB sweep (write; operator pre-approved orbis demotion)
Block every `orbisapi.com` row currently selectable. Run via Neon MCP against
project `super-grass-68246474` (read `NEON_PROJECT_ID`). **Re-query first** to
confirm the set, then:

```sql
UPDATE service_registry
SET status = 'blocked', updated_at = now()
WHERE resource ILIKE '%orbisapi.com%'
  AND status IN ('active','probation');
```

Then confirm:
```sql
SELECT category,
       count(*) FILTER (WHERE status='active')    AS active,
       count(*) FILTER (WHERE status='probation') AS probation,
       count(*) FILTER (WHERE status='blocked')   AS blocked
FROM service_registry GROUP BY category ORDER BY category;
```

### A2 — host denylist in discovery (code)
Add an env-configurable dead-host denylist so orbis (and future dead providers)
are never re-inserted or selected.

- **Files:** `src/vetter/run.ts` (discovery-insert loop, next to the existing
  `isLikelyInvokableEndpoint` filter — `runVetter` step 2), `src/registry/select.ts`
  (defensive skip in `selectFromRegistry`).
- **Mechanism:** read `DISCOVERY_HOST_DENYLIST` (comma-separated hosts, **default
  `orbisapi.com`**); add `isDeniedHost(resource): boolean`. Skip denied hosts at
  insert (log `skipping denied host`) and exclude them in selection candidate
  building. Env-overridable so it's not a permanent hardcode if orbis re-enables
  x402. Note `insertCandidate` already skips existing resources, so A1+A2 fully
  stop orbis.

**Acceptance criteria:**
- After A1: no orbis row is `active`/`probation`; live `/verify-agent` runs show
  no `target_api_is_not_x402_enabled` orbis receipts.
- After A2: a vetter discovery run does not insert any `orbisapi.com` candidate;
  `selectFromRegistry` never returns an orbis service even if one is `probation`.

**Validation commands:**
```
~/.deno/bin/deno check src/vetter/run.ts src/registry/select.ts
~/.deno/bin/deno lint  src/vetter/run.ts src/registry/select.ts
~/.deno/bin/deno test --allow-net --allow-env --allow-read src/vetter/ src/registry/
```

**Test spec (new cases):**
- `run_test.ts`: "runVetter: skips candidates from a denied host" (orbis candidate
  not inserted; non-orbis inserted).
- `run_test.ts`: "DISCOVERY_HOST_DENYLIST env overrides the default host set".
- `select_test.ts`: "selectFromRegistry: a denied-host probation row is excluded"
  (DB path, via `getActive` seam returning an orbis row → not in plan).

---

## Ticket B — Make eth-labels a first-class direct source (fixes diagram node + receipt)

**Root cause:** `fetchLabelsRegistry` is called in the parallel block of
`verifyAgent` (`src/agent/verify.ts` ~L714–753) and merged into `findings.labels`,
but emits **no service event and creates no outcome** — unlike ENS
(`resolveEnsWithEvents`) and the oracle, which emit `kind:"direct"` events. Mirror
that pattern.

- **Files:** `src/agent/verify.ts` (wrap the eth-labels call like
  `resolveEnsWithEvents`), reuse `ServiceEvent` from `src/agent/events.ts`
  (`kind:"direct"`, `cost_usd:null`). Reference impl: `resolveEnsWithEvents`
  (~L357–430) and the oracle emitter (~L282–353).
- **Emit:** `service` `start` then `ok`/`error` with
  `resource:"eth-labels://eth"`, `category:"labels"`, `kind:"direct"`.
- **Outcome:** push a synthetic `ServiceInvocationOutcome` (`status:"ok"`/`error`,
  `paid:false`, `amountUsdc:0`, `adapterPath` — reuse existing slot,
  `durationMs:<measured>`) into the outcomes that become `receipts`, so labels
  shows a receipt even with no paid service.
- **Optional:** add an eth-labels / viem entry to `buildDeterministicSources`
  (`src/discovery/deterministic_sources.ts`) so the plan card lists them upfront.

The **existing frontend already renders `kind:"direct"` events as nodes**
(`useFlowState.ts` `ensureCategory` on `service` events; `DirectNodes` in
`FlowDiagram.tsx`), so this backend change makes the labels node reappear with no
frontend code.

**Acceptance criteria:**
- `/verify-agent-stream` for a wallet with no paid labels service emits a
  `labels` `kind:"direct"` service event (start + ok/error).
- `/verify-agent` response `receipts[]` includes a `labels` entry with
  `paid:false` when only eth-labels resolved it.
- `coverage.resolved` still includes `labels` (unchanged); no verdict regression.

**Validation commands:**
```
~/.deno/bin/deno check src/agent/verify.ts
~/.deno/bin/deno lint  src/agent/verify.ts
~/.deno/bin/deno task test:replay      # logic-only, no new HTTP → expect 9/9
~/.deno/bin/deno task check
```
> Replay note: this adds an outcome but no new HTTP call, so **no cassette
> re-record**. If a replay/verify test asserts an exact outcome/receipt count,
> update that assertion (it's a logic change, not a regression).

**Test spec (new cases):**
- `verify_test.ts`: "verifyAgent emits a direct labels service event for
  eth-labels" (assert event captured via the test emitter seam).
- `verify_test.ts`: "labels appears in outcomes/receipts when only eth-labels
  resolves it (no paid labels service in plan)".

---

## Ticket C — Frontend regression sweep (scoped)

The flow diagram assumes "category nodes come from the paid plan + service events"
(`web/src/hooks/useFlowState.ts` L168–219). That breaks for free-only / no-source
categories as orbis dies. Ticket B fixes labels; sweep the rest.

- **Files:** `web/src/hooks/useFlowState.ts`, `web/src/components/FlowDiagram.tsx`,
  `web/src/api.ts`, `web/src/types.ts`.
- **Scenarios to verify/fix:**
  1. labels covered by eth-labels only → node renders (after B). ✅ verify.
  2. `web_sentiment` with NO source at all → currently draws nothing; decide
     "skipped / no source" node vs intentional omit — don't let it read as broken.
  3. invoke-phase-end idle→ok/error cascade (L131–164) for direct-only rows —
     ensure a category resolved by a free source never flips to `error`.
  4. `spent vs est` mismatch display sanity.
- **Deliverable:** a frontend ticket enumerating scenarios + the small fixes.

**Acceptance criteria:** against a fresh wallet in the live UI, every category in
`coverage.resolved` has a node and none resolved-by-free-source renders as error.

**Validation commands:**
```
cd web && npm run typecheck && npm run build
# Manual: load UI (npm run dev) against a fresh wallet; confirm labels + ens nodes
# render and no resolved category shows error. Use the preview_* tools.
```

**Test spec:** add/extend `useFlowState` unit tests (if present) for: a `service`
`kind:"direct"` labels event creates a category node; a category with only a
failed paid service but a successful direct event resolves to `ok`.

---

## Ticket D — onchain_history floor (OPEN — operator deferred, do not block)

viem's free public RPCs fail from Deno Deploy egress, so onchain only resolves
when paid `ottoai` is alive. Recommended fix when the operator is ready:
- Set `RPC_URL_ETH` / `RPC_URL_BASE` on Deno Deploy to a **keyed provider**
  (Alchemy/Infura free tier — datacenter-friendly). `src/agent/onchain_viem.ts`
  already reads these (comma-separated). Also hardens the sanctions oracle + ENS,
  which read the same vars.
- Optional companion: promote `x402.ottoai.services/transaction-history` to
  `active` so it's the onchain primary, not a lucky alternate.
No code change required for the env path. Verify by forcing the viem path (fresh
wallet / no paid onchain) and confirming a `viem://eth` `ok` event + resolved
onchain_history.

---

## Prod evidence to re-verify before executing (read-only, Neon MCP)

```sql
-- catalog by category × host × status (expect orbis dead, anchor active)
SELECT category,
       CASE WHEN resource ILIKE '%orbisapi.com%' THEN 'orbis' ELSE 'non-orbis' END AS host,
       status, count(*) n
FROM service_registry WHERE status IN ('active','probation')
GROUP BY category, host, status ORDER BY category, host, status;

-- which non-orbis services actually work (30d)
SELECT resource,
       count(*) FILTER (WHERE status='ok')    ok,
       count(*) FILTER (WHERE status='error') err,
       max(created_at) last_seen
FROM service_observations
WHERE created_at >= now() - interval '30 days'
  AND resource NOT ILIKE '%orbisapi.com%' AND resource NOT LIKE 'viem://%'
GROUP BY resource ORDER BY ok DESC;
```

## Suggested execution order / PRs
1. **A1** (DB sweep, immediate operator value) — Neon MCP, with confirmation.
2. **PR: A2 + B** (host denylist + eth-labels events) — one backend PR; replay 9/9,
   check+lint clean.
3. **PR: C** (frontend sweep) — depends on B; verify in the live UI.
4. **D** — operator decision, separate, non-blocking.

## Agent-memory reminder (per CLAUDE.md)
On completion, append a `docs/agent-log.md` row and a `docs/features/<slug>.md`
per ticket/PR; move this file to `docs/plans/completed/`.
