# reliability-round2-frontend-sweep

**What:** Frontend regression sweep (Ticket C) confirming the flow diagram
handles free-only / no-source categories now that orbis is dead; the only code
fix needed was a clean label for the new eth-labels direct node.

## Files

- `web/src/hooks/useFlowState.ts` — `directLabel()` returns `"eth-labels"` for
  `eth-labels://*` (was falling through to the raw `eth-labels://eth` URI), and
  `isDirectKind()` lists `eth-labels://` in its resource-prefix fallback (for
  event streams missing the `kind:"direct"` flag).

## Config

None.

## Notes — sweep findings (the four scoped scenarios)

The ENS direct-node work in #76 already generalized the diagram to handle
categories resolved purely by free chain-primitives, so most scenarios were
**already correct**; the sweep confirmed them rather than changing code:

1. **labels covered by eth-labels only → node renders.** After Ticket B the
   backend emits `labels` `kind:"direct"` events; `ensureCategory` creates the
   node, the per-event direct-ok promotion (useFlowState L198–205) flips it to
   `ok`, and `FlowDiagram` draws the direct circle + category→synth edge for a
   no-x402 category. Only gap was the circle label → fixed.
2. **web_sentiment with NO source → no node.** It never enters
   `coverage.resolved` (it's unresolved), so per the acceptance criterion it
   needs no node. With no plan service and no service event the category is
   simply omitted — it does not render as broken. Left as-is (intentional omit).
3. **invoke-end cascade for direct-only rows.** useFlowState L148–162 already
   resolves a direct-only category to `ok` when a direct path succeeded (and to
   `error` only when every direct path failed) — a category resolved by a free
   source never flips to `error`. Confirmed, no change.
4. **spent vs est.** `result` reconciles `spentUsdc` to the grand total; est
   reflects the (now smaller, orbis-free) paid plan. Sane, no change.

## Validation

- `cd web && npm run typecheck && npm run build` — clean (55 modules).
- Dev-server smoke (preview tools): app boots, zero console errors.
- **Live-UI visual check of the labels node is gated on Ticket B being
  deployed** (the backend must emit the `eth-labels://eth` direct events). Run
  it against a fresh wallet once PR #77 is live: confirm a `labels` node with an
  `eth-labels` direct circle renders and resolves `ok`, alongside `ens`.
- No frontend test framework exists in `web/`, so no unit tests were added
  (the plan's test spec was conditioned on "if present").
