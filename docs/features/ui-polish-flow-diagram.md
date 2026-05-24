# ui-polish-flow-diagram

**What:** Cosmetic + correctness pass on the demo's three read surfaces (PlanCard, VerdictCard, FlowDiagram). PlanCard now visually separates paid services from the always-on free checks with a dashed divider. VerdictCard adds three uppercase section headers — `Summary`, `Category findings`, `Paid services breakdown` — so the structure is scannable instead of three undelimited blocks. FlowDiagram (1) widens chain-dot spacing so the 5-chain sanctions sub-fan-out labels stop blurring, (2) wraps each sub-fan-out (sanctions oracles, ENS) in a dashed container rect so the row reads as one widget anchored to its parent category, (3) stops rendering the ENS edge as red on success (direct-only categories were getting cascaded to `error` because the `start→active` transition was never reversed by the `ok` handler), and (4) renders fallback flows as a single chain (`primary →(red)→ fallback →(green)→ synth`) instead of the prior two parallel edges into `synth`.

**Files:**

- `web/src/components/PlanCard.tsx` — wrapper around the deterministic-sources block now uses `marginTop: 22 / paddingTop: 14 / borderTop: 1px dashed var(--faint)` instead of `marginTop: 10`.
- `web/src/components/VerdictCard.tsx` — three new uppercase muted `<div>` headers (`Summary` / `Category findings` / `Paid services breakdown`) using a shared local `sectionHeaderStyle` constant matching PlanCard's "Always-on free checks" tag.
- `web/src/components/FlowDiagram.tsx` —
  - `DIRECT_SPACING` bumped from 26 to 38 (Bug 3).
  - `DirectNodes` wraps the dots+labels in a `<rect class="direct-container">` with computed padding (Bug 4).
  - `edgeCatToSynthDirect` now derives color from `node.status` alone — downstream `synthStatus` no longer poisons the direct edge red (Bug 5, defense-in-depth).
  - `edgePayToSynth` is suppressed (and the `<path>` itself is conditionally not rendered) when `node.fallback` exists (Bug 6).
  - `edgePayToFallback` is colored `error` (red) when `primaryStatus === "error"` instead of always dashed orange — the actual story is that primary errored.
- `web/src/components/FlowDiagram.css` — new `.flow-diagram .direct-container` rule (translucent fill, dashed `#3A4A5A` stroke) for the sub-fan-out wrapper.
- `web/src/hooks/useFlowState.ts` —
  - Direct-event `ok` handler now promotes `node.status` from `active→ok` (provided no x402 primary is mid-flight/errored and no sibling direct errored). Previously the `start` handler set `node.status = "active"` and the `ok` handler's promotion was gated on `=== "idle"`, so it never fired. The invoke-end cascade then flipped `active→error` — that's why ENS rendered red on success (Bug 5, root cause).
  - The invoke-end cascade now distinguishes direct-only categories: `active` flips to `ok` if at least one direct succeeded and none errored; otherwise `error`. Without this, the cascade unconditionally turned any still-active direct-only category into `error`.

**Config:** No new env vars, no new dependencies, no new endpoints. Pure UI / state-derivation changes inside the web SPA.

**Notes:**

- *Verified end-to-end against the real backend* (no mocks) on `bob-the-builder.eth` / `0xdAD87539a14f81a909C5A6Ca39bd6dCa4DD55D96` (network `base`). PlanCard divider visible, three VerdictCard section headers appear in the accessibility tree (`SUMMARY`, `CATEGORY FINDINGS`, `PAID SERVICES BREAKDOWN`). FlowDiagram DOM inspection confirms: 5 sanctions chain dots at x=304/342/380/418/456 (spacing 38), one `.direct-container` rect per sub-fan-out (sanctions w=186, ENS w=34), ENS edges both `edge ok`, total 15 edges in the clean run (down from 17 — the two suppressed are pay→synth in rows that took a fallback).
- *No web tests added.* `web/package.json` doesn't wire vitest/jest and the plan's regression case was conditional on a runner being present; adding a test runner for one case would be scope creep. The fix is covered by the e2e check above and protected by `npm run typecheck`.
- *ENS bug root cause was in `useFlowState.ts`, not FlowDiagram.* The original suspicion was that `edgeClassFor` was getting poisoned by `synthStatus`. That contributed (the direct-edge color now derives from `node.status` alone, as defense-in-depth), but the real bug was `node.status` getting stuck at `active` for direct-only categories because the `ok` handler's promotion was gated on `=== "idle"`.
- *Backwards compatibility.* No event-shape changes; no API changes. Existing fixtures still parse identically.
