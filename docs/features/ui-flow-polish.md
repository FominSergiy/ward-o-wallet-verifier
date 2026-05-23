# ui-flow-polish

**What:** Three small UI polish changes — show the flow diagram on the plan tab (with flow as the default view on both tabs), bump the flow diagram container to 480px (logs stays 320px), and only flush prior plan/verdict/log state when the wallet address changes (so plan persists across an execute click for the same address within a session).

**Files:**
- `web/src/components/TerminalTabs.tsx` — dropped the `showToggle = active === "verify"` gate; the logs/flow toggle now renders for both tabs.
- `web/src/components/FlowDiagram.tsx` — `VIEW_H` bumped 320 → 480 so the SVG viewBox matches the new container.
- `web/src/components/FlowDiagram.css` — `.flow-diagram { height: 480px }`.
- `web/src/App.tsx` — added `lastRunAddressRef` + `flushIfNewAddress()` helper called from both `handlePlan` and `handleExecute`; per-mode clears retained for same-address re-runs.

**Config:** none.

**Notes:**
- The flow diagram in plan mode shows origin (verify agent, ok) → categories with planned x402 prices in `idle` styling → synth/verdict still `idle`. Powered by existing `useFlowState` — no hook changes needed.
- `flushIfNewAddress` uses a `useRef`, not state, to avoid an extra render and stale-closure issues when consecutive clicks land in the same tick.
- The pre-existing 24 `deno lint` `no-sloppy-imports` errors in `web/src/**` are unchanged (the React code uses Vite/TS-style imports; type-checking is via `npm run typecheck` / `tsc`).
