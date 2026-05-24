# ui-transparency-pass

**What:** Surfaces three things the verify pipeline already did but the UI hid: (1) the free deterministic sources (Chainalysis on-chain oracle, eth-labels.com registry, ENS reverse resolver) are now listed in the plan card under "Always-on free checks" with $0 cost and rationale tooltips; (2) the `adapterPath` per receipt is rendered as a small badge in the verdict card so the orbisapi `pattern+subpath` descriptor-retry and LLM fallbacks are visible at a glance; (3) every category chip carries a native `title` tooltip with a one-sentence audience-facing definition.

**Files:**

- `src/discovery/deterministic_sources.ts` *(new)* — `buildDeterministicSources(categories, walletNetwork)` returns the always-on sources plus the category-gated ones (eth-labels for `labels`, ENS for `ens`). Pure data; no side effects.
- `src/discovery/deterministic_sources_test.ts` *(new)* — 5 tests covering: always-on Chainalysis, gated eth-labels, gated ENS, stable order for the full default, omission when gated categories absent.
- `src/discovery/types.ts` — `DiscoveryPlan` gains required `deterministicSources: DeterministicSource[]`.
- `src/discovery/discover.ts` — populates the field after building paid `services`.
- `src/agent/events.ts` — `PlanEvent` gains optional `deterministicSources`.
- `src/routes/discover_stream.ts` — passes the field through in the final `plan` SSE frame; **`DEFAULT_CATEGORIES` aligned with `verify.ts`** (added `ens`) so the plan card mirrors what Execute will actually run.
- `src/agent/verify.ts`, test plan literals in `src/agent/{invoke_all,verify}_test.ts` and `src/routes/{discover_stream,verify_agent_stream}_test.ts` — all `DiscoveryPlan` constructions add `deterministicSources: []`.
- `web/src/types.ts` — adds `DeterministicSourceView`, extends `PlanView` and `PlanEvent`, tightens `VerifyReceipt.adapterPath` to the three-value union and adds `errorCode?: string` to close the backend-frontend type gap.
- `web/src/api.ts` — already passes the parsed plan event through; no changes (event passes whole).
- `web/src/App.tsx` — propagates `deterministicSources` from the `plan` event into `PlanView`.
- `web/src/categoryLabels.ts` *(new)* — `CATEGORY_HINTS: Record<Category, string>` keyed by `Category`.
- `web/src/components/PlanCard.tsx` — renders the new "Always-on free checks" subsection beneath the paid services list; adds `title={CATEGORY_HINTS[…]}` to every category chip (paid and free).
- `web/src/components/VerdictCard.tsx` — renders an `adapterPath` badge inside the resource cell (muted for `pattern`, accent for `pattern+subpath`, warn for `llm`); adds category-hint titles to both findings and receipts loops.

**Config:** No new env vars, no new external dependencies, no new endpoints called. Total estimated cost on the plan card stays paid-only (free sources carry `priceUsdc: 0` and are excluded from the sum because the sum is computed over `services`, not `deterministicSources`).

**Notes:**

- *Not a behavior change.* The deterministic sources already ran inside `verify.ts` (Chainalysis fan-out + `wantEns`/`wantLabels` parallel calls). This change is presentation-only: it does NOT touch `invoke_all.ts`, `synthesize_verdict.ts`, ranking, alternates, or any cost accounting. The split between paid x402 services and free chain primitives is unchanged.
- *Why `ens` was added to `/discover-stream` defaults.* The plan card is meant to preview an Execute run. `verify-agent` always runs ENS; `/discover-stream` used to omit it. Adding it costs one extra Bazaar query that returns zero candidates (no paid ENS service exists today) — `discover.ts:64` already filters `ens` from `unresolvedCategories`, so the plan card doesn't show ENS as a gap.
- *Pre-existing type errors on main.* `~/.deno/bin/deno task check` reports 2 errors in `src/agent/verify.ts` (`req.chain` on a `{address}`-typed request) and 4 test references to a non-existent `cleanOracle` symbol in `src/agent/verify_test.ts`. These exist on `main` and are untouched here. All 5 new tests + the touched test files pass with `--no-check`.
- *Badge styling reads CSS vars.* `var(--accent)` and `var(--warn)` aren't defined in the project's theme — they fall back to the literal RGB values inlined in `adapterBadgeStyle`. If a follow-up adds proper theme tokens, the badges will pick them up automatically.
- *Smoke test.* Vitalik (`0xd8dA…6045`) plan: 5 paid services (sanctions $0.001, labels orbisapi $0.005, onchain_history $0.005, web_sentiment $0.007, contract_analysis $0.024) + 3 free rows; total $0.042. Verdict: `safe_to_transact`, confidence high, headline cites ENS-doxxed identity + Chainalysis clean. Receipt badges: `pattern` (sanctions), `pattern+subpath` (orbisapi labels — the descriptor-retry feature in action), `pattern` (onchain_history), `llm` (web_sentiment fallback).
