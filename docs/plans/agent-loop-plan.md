# Plan: Agentic Verification Harness

## Context

`agnic-agent-wallet-verifier` today runs a **static DAG** (`src/dag/runner.ts`) — six nodes (preflight → sanctions/web_search/onchain/ens → synthesis) wired in code with hard-coded dependencies. The only LLM call is the final synthesis (`src/dag/nodes/synthesis.ts`).

We want to move to a **plan-execute-synthesize loop** where the LLM decides what to call, the harness executes with a budget, and the LLM synthesizes the result. Goal: each input/output is determined by model reasoning, with a deterministic harness for budget, retries, receipts, and early-exit.

**Decisions locked in:**
- New `POST /verify-agent` route — leave the existing `/verify` + DAG intact for A/B and demo fallback.
- **Deterministic phase grouping** — `llmPlan` returns categories only; `phaseGroups()` applies a fixed rule (labels+sanctions first, everything else second).
- **Dependency injection for the LLM** — each function accepts an optional `llm` client parameter. Tests pass a mock; production passes the real one from `gateway.ts`.

---

## Status

| Ticket | Branch | File | Status |
|--------|--------|------|--------|
| 0 | `feat/move-to-agent-loop-ticket-0` | `src/agent/types.ts`, `src/agent/llm.ts` | ✅ merged |
| 1 | `feat/move-to-agent-loop-ticket-1` | `src/agent/plan.ts` | 🔲 |
| 2 | `feat/move-to-agent-loop-ticket-2` | `src/agent/resolve.ts` | 🔲 |
| 3 | `feat/move-to-agent-loop-ticket-3` | `src/agent/phases.ts` | 🔲 |
| 4 | `feat/move-to-agent-loop-ticket-4` | `src/agent/budgeted_call.ts` | 🔲 |
| 5 | `feat/move-to-agent-loop-ticket-5` | `src/agent/merge.ts` | 🔲 |
| 6 | `feat/move-to-agent-loop-ticket-6` | `src/agent/stop.ts` | 🔲 |
| 7 | `feat/move-to-agent-loop-ticket-7` | `src/agent/synthesize.ts` | 🔲 |
| 8 | (user) | `src/agent/verify.ts`, `src/routes/verify_agent.ts` | 🔲 user-owned |

---

## Shared scaffolding (Ticket 0 — ✅ done)

Files created in `src/agent/`:
- `types.ts` — `CategorySchema`, `PlanSchema` (`.describe("Plan")`), `EarlyStopSchema`, `Plan`, `Category`, `Call`, `Receipt`, `AgentCtx`
- `llm.ts` — `LlmClient` interface, `defaultLlm`, `mockLlm(fixtures)` factory keyed by schema description

Also: `deno task test` added to `deno.json`, `@std/assert` in import map.

---

## Ticket 1 — `llmPlan(address, chain, llm?) → Plan`

**File:** `src/agent/plan.ts`

```ts
export async function llmPlan(
  address: string,
  chain: Chain,
  llm: LlmClient = defaultLlm,
): Promise<Plan>
```

Builds a prompt, calls `llm.generateStructured(PlanSchema, prompt)`, returns result.

**Prompt:** asks model to pick a subset of `CategorySchema` values, provide a one-sentence rationale, and set earlyStop flags (default all true).

**Tests** (`src/agent/plan_test.ts`):
1. `mockLlm({ Plan: fixture })` → result validates `PlanSchema`, categories non-empty
2. No duplicate categories
3. Custom capturing `LlmClient` → prompt contains address and chain strings

---

## Ticket 2 — `resolveBazaarEndpoints(categories, chain) → Call[]`

**File:** `src/agent/resolve.ts`

```ts
export function resolveBazaarEndpoints(categories: Category[], _chain: Chain): Call[]
```

Pure deterministic map. `phase` defaults to `1` (overridden by `phaseGroups`).

```ts
const CATEGORY_MAP = {
  sanctions:         { provider: "bazaar/ofac",       endpoint: "bazaar/ofac",       estimatedCostUsdc: 0.0010 },
  labels:            { provider: "bazaar/labels",     endpoint: "bazaar/labels",     estimatedCostUsdc: 0.0008 },
  onchain_history:   { provider: "etherscan",         endpoint: "etherscan",         estimatedCostUsdc: 0.0007 },
  web_sentiment:     { provider: "bazaar/web-search", endpoint: "bazaar/web-search", estimatedCostUsdc: 0.0005 },
  ens:               { provider: "viem/public-rpc",   endpoint: "ens-reverse",       estimatedCostUsdc: 0      },
  contract_analysis: { provider: "bazaar/contract",   endpoint: "bazaar/contract",   estimatedCostUsdc: 0.0030 },
};
```

**Tests** (`src/agent/resolve_test.ts`): length, correct providers, determinism, order preservation.

---

## Ticket 3 — `phaseGroups(calls) → Call[][]`

**File:** `src/agent/phases.ts`

```ts
export function phaseGroups(calls: Call[]): Call[][]
```

Phase 1 = `sanctions` + `labels`. Phase 2 = everything else. Mutates `call.phase`. Drops empty phases.

**Tests** (`src/agent/phases_test.ts`): mixed input, only ens, only sanctions, empty, order preserved.

---

## Ticket 4 — `budgetedCall(call, ctx, budgetCeiling, invoker?, timeoutMs?, backoffsMs?) → CallOutcome`

**File:** `src/agent/budgeted_call.ts`

```ts
export interface CallOutcome { call: Call; data: unknown | null; receipt: Receipt; }
export type Invoker = (call: Call, ctx: AgentCtx) => Promise<{ data: unknown; amountUsdc: number; txHash?: string }>;

export async function budgetedCall(
  call: Call, ctx: AgentCtx, budgetCeiling: number,
  invoker = defaultInvoker, timeoutMs = 5000, backoffsMs = [200, 800]
): Promise<CallOutcome>
```

1. Budget pre-check → `skipped_budget` if over
2. Race invoker against timeout → `timeout` if exceeded
3. Retry up to 3× total with backoff on error
4. Capture amountUsdc, txHash, durationMs

`defaultInvoker` dispatches by category to existing stub DAG nodes (`src/dag/nodes/*.ts`).

**Tests** (`src/agent/budgeted_call_test.ts`): success, all-fail+retry count, timeout, budget skip, retry-then-succeed.

---

## Ticket 5 — `mergeResults(ctx, outcomes) → void`

**File:** `src/agent/merge.ts`

```ts
export function mergeResults(ctx: AgentCtx, outcomes: PromiseSettledResult<CallOutcome>[]): void
```

- `fulfilled` + `status === "ok"` → writes to `ctx.findings[category]`
- All outcomes → append receipt to `ctx.receipts`, add `amountUsdc` to `ctx.spent`
- `rejected` → synthetic error receipt (`callId: "unknown:unknown"`, `amountUsdc: 0`)

Note: `CallOutcome` is locally re-declared in `merge.ts` (ticket 4 runs in parallel). Ticket 8 reconciles.

**Tests** (`src/agent/merge_test.ts`): mixed outcomes, single ok, rejected promise, empty input.

---

## Ticket 6 — `shouldStopEarly(ctx, earlyStop, budgetCeiling) → boolean`

**File:** `src/agent/stop.ts`

```ts
export const CONFIRMED_SAFE_LABELS = ["binance", "coinbase", "kraken", "okx"] as const;
export function shouldStopEarly(ctx: AgentCtx, earlyStop: Plan["earlyStop"], budgetCeiling: number): boolean
```

Returns true if:
1. `onSanctionHit` + `ctx.findings.sanctions.sanctioned === true`
2. `onConfirmedSafeLabel` + findings.labels contains a CONFIRMED_SAFE_LABELS entry (case-insensitive)
3. `budgetExhausted` + `ctx.spent >= 0.99 * budgetCeiling`

Narrows all `unknown` findings before reading fields.

**Tests** (`src/agent/stop_test.ts`): 8 cases covering all branches and narrowing edge cases.

---

## Ticket 7 — `llmSynthesize(ctx, llm?) → RiskReport`

**File:** `src/agent/synthesize.ts`

```ts
export async function llmSynthesize(ctx: AgentCtx, llm: LlmClient = defaultLlm): Promise<RiskReport>
```

Reuses `RiskReportSchema` from `src/dag/types.ts`. Prompt includes plan rationale, findings, spend/receipts summary, same rules as existing synthesis node.

**Tests** (`src/agent/synthesize_test.ts`): happy path, schema rejection (riskScore 150), prompt capture.

---

## Ticket 8 — Orchestrator + Route (user-owned)

**Files:** `src/agent/verify.ts`, `src/routes/verify_agent.ts`, wire in `src/main.ts`

```ts
export async function verifyAgent(
  req: VerifyRequest,
  opts: { budgetCeiling: number; llm?: LlmClient } = { budgetCeiling: 0.05 },
): Promise<{ report: RiskReport; ctx: AgentCtx }>
```

Route: `POST /verify-agent`, same body as `/verify` + optional `budgetCeiling`. Returns `{ report, ctx }` for demo audit trail.

---

## Running agents

Each worktree is at `/Users/sfomin/project-space/agnic-agent-wallet-verifier-ticket-N`.
Each has `.claude/settings.local.json` with the required permissions.
Deno binary: `~/.deno/bin/deno`

Verification per ticket:
```bash
cd /Users/sfomin/project-space/agnic-agent-wallet-verifier-ticket-N
~/.deno/bin/deno check src/agent/<file>.ts src/agent/<file>_test.ts
~/.deno/bin/deno lint src/agent/<file>.ts src/agent/<file>_test.ts
~/.deno/bin/deno test --allow-net --allow-env src/agent/<file>_test.ts
git add src/agent/<file>.ts src/agent/<file>_test.ts
git commit -m "ticket N: ..."
git push -u origin feat/move-to-agent-loop-ticket-N
```
