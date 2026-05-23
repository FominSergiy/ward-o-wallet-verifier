# flow-viz

**What:** A pure-SVG flow diagram on the Execute tab that visualizes the verify-agent's fanout into category services, x402 payments (and fallback retries on failure), synthesis, and final verdict — all derived live from the SSE `VerifyEvent[]` already powering the log stream.

**Files:**

- `web/src/hooks/useFlowState.ts` — pure reducer over `VerifyEvent[]` producing `FlowState { origin, categories[primary+fallback], synthesize, verdict, spentUsdc, estimatedUsdc }`.
- `web/src/components/FlowDiagram.tsx` — SVG renderer (fixed left-to-right topology, dynamic per-category rows).
- `web/src/components/FlowDiagram.css` — node/edge classes (idle / active / ok / error / fallback), CSS-keyframe pulse, view-toggle styles.
- `web/src/components/TerminalTabs.tsx` — gained a `logs ⇄ flow` segmented toggle, only shown on the Execute tab.
- `web/vite.config.ts` — proxy target now reads `VITE_API_PORT` (defaults to `8000`), so a worktree can point the dev server at a non-standard backend port.

**Config:**

- New optional env var **`VITE_API_PORT`** (Vite-only; read from `web/.env`). When unset, the proxy talks to `localhost:8000` exactly like before.
- Backend port unchanged — controlled by existing `PORT` env var.
- No new runtime dependencies (no react-flow, no animation lib).

**Notes:**

- The hook treats a `service:start` whose resource differs from `primary.resource` as a fallback attempt (covers both the `service:fallback` event path and the case where the backend simply emits a fresh `service:start` for an alternate).
- On `phase:invoke:end`, any sub-node still `active` is promoted to `error` so the diagram never shows a stuck-pulsing diamond after invoke completes (observed for web_sentiment when no usable alternate exists).
- The category-row layout supports at most one rendered fallback diamond per row; if a category goes primary → alt1 → alt2 (as happened for contract_analysis in E2E testing), the alt2 result overwrites the alt1 slot. Acceptable for v1; if multi-hop visualization becomes important, render `node.attempts[]` instead.
- The diagram is non-interactive in v1 — no click-to-drill, no tooltips. Status + price labels only.
- E2E verified against `0xd8da6bf26964af9d7eed9e03e53415d37aa96045` (vitalik.eth) with backend on port 8765 in worktree `../agnic-flow-viz` (branch `feat/flow-viz`). Verdict came back `safe_to_transact`; flow tab showed origin/labels/sanctions/on_chain/contract green, web_sentiment with red primary diamond + amber dashed fallback diamond, synth+verdict green, spend `$0.015 / est $0.039`.
