# ui-flow-grouping-fallback-receipt

**What:** Two frontend-only UI fixes — group the flow diagram's free
chain-primitive sub-nodes under their category (relabeled "free sources"), and
show cost + duration for `fallback_ok` receipt rows so the breakdown math
reconciles.

**Files:**
- `web/src/components/FlowDiagram.tsx` — `DirectNodes` re-anchored to
  `CATEGORY_X` and docked below the category box; added connector `<line>`;
  caption "direct" → "free sources"; `DIRECT_DY` 22 → 46.
- `web/src/components/FlowDiagram.css` — `.direct-row-tag` → `.direct-caption`
  (centered); added `.direct-connector`; updated `.direct-container` comment.
- `web/src/components/VerdictCard.tsx` — `receiptStatusLabel` and
  `receiptErrorText` now treat `fallback_ok` like `ok` (render `$cost · Nms`).
- `web/src/types.ts` — `VerifyReceipt.status` union widened to include
  `"fallback_ok"`.

**Config:** None. No env vars, no backend, no DB, no cassettes touched.

**Notes:**
- The `fallback_ok` display fix also fixes the "math doesn't add up" bug: the
  backend already sums the `fallback_ok` `amountUsdc` into `totalSpentUsdc`
  ([src/agent/invoke_all.ts:554](../../src/agent/invoke_all.ts)) and forwards
  both `amountUsdc` and `durationMs`
  ([src/routes/verify_agent_stream.ts:36](../../src/routes/verify_agent_stream.ts)),
  but the UI was hiding the cost from the row. One render change fixed both the
  timing display (#2) and the subtotal mismatch (#3). No backend change needed.
- The `[llm]` adapter badge already distinguishes a fallback row, so the status
  label intentionally renders identically to `ok` (no extra "fallback" text).
- Verified visually with a temporary Vite multi-page harness
  (`web/preview.html` + `web/src/preview-harness.tsx`) feeding synthetic
  events/result that reproduce the screenshot scenario — live render would need
  a real paid verify run. Harness deleted after screenshotting; if you need to
  re-verify a future flow-diagram change without spending, recreating that
  harness is the cheapest path.
- No frontend test framework exists in `web/`; the gate is `npm run typecheck`.
  Known cosmetic pre-existing issue (not addressed here): the 5-chain sanctions
  oracle labels (`arbitrum`/`optimism`) crowd at `DIRECT_SPACING` 38px.
