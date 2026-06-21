# timeout-10s-and-llm-cost-line-item

**What:** Raises the per-call x402 invocation timeout to 10s, and captures + displays AI-model (LLM) call cost as its own line item in the verdict card, alongside x402 spend and a combined total.

## Files

Backend:
- `src/agent/invoke_all.ts` — `DEFAULT_INVOKE_TIMEOUT_MS` default `5000` → `10000` (env `INVOKE_TIMEOUT_MS` still overrides).
- `src/gateway.ts` — added `onCost?: (usd: number) => void` to `GenerateStructuredOpts`; after a successful response, parses `agnic.cost_usd` and invokes `onCost` (best-effort — missing/NaN is swallowed, never throws).
- `src/agent/llm.ts` — added `LlmCostSink` interface and `withCostTracking(inner, sink)` decorator that injects a cost-accumulating `onCost` into every call (chaining any caller-supplied one).
- `src/agent/verify.ts` — wraps `opts.llm ?? defaultLlm` once with `withCostTracking` so descriptor-retry + synthesis all accrue; added `totalLlmCostUsd` to `VerifyAgentResult` (returned as `0` on the cache-hit and oracle-sanctioned short-circuits, since neither runs an LLM call). **Must wrap the default, not only a caller-supplied client:** the route passes no `llm`, so components fall back to their own `defaultLlm` via `?? defaultLlm` — wrapping only `opts.llm` left that fallback untracked and `totalLlmCostUsd` stuck at 0. Wrapping the default and threading it down is behavior-neutral (selectFromRegistry makes no LLM calls; synthesis/adapter already used `defaultLlm`).
- `src/routes/verify_agent.ts`, `src/routes/verify_agent_stream.ts` — add `totalLlmCostUsd` to the JSON response / SSE result payload.

Frontend:
- `web/src/types.ts` — `totalLlmCostUsd: number` on `VerifyResultPayload`.
- `web/src/components/VerdictCard.tsx` — `x402 services` + `AI model calls` subtotal rows and a combined `Total spent` (= x402 + LLM).
- `web/src/theme.css` — `.cost-subtotal` rule.

Tests:
- `src/gateway_test.ts` — `onCost` fires with parsed cost; skipped when absent; no throw on malformed cost.
- `src/agent/llm_test.ts` — `withCostTracking` accumulates across calls, preserves model-string arg, chains caller `onCost`.
- `src/agent/verify_test.ts` — `totalLlmCostUsd` summed from pipeline LLM calls; `0` on oracle short-circuit.
- `src/routes/verify_agent_stream_test.ts` — asserts `totalLlmCostUsd` in the result payload.

## Config

None added. Existing `INVOKE_TIMEOUT_MS` continues to override the (now 10s) per-call timeout default.

## Notes

- `totalSpentUsdc` deliberately keeps its x402-only meaning; the grand total is computed client-side in the card.
- LLM cost is `$0.0000` on a cache hit — correct, since no synthesis runs.
- **No cassette re-record:** the change only reads `agnic.cost_usd` (already present in recorded gateway responses) and does not alter request URL/method/path/body. `deno task test` (incl. replay) stays green — 319 passed.
- The 60s `agnicFetch` gateway timeout (`src/clients/agnic.ts`) is the outer backstop and was left unchanged.
- **Browser-verified live** against the running app (Vite → local backend). A fresh, uncached address (`insufficient_data`, never cached → synthesis always runs) rendered the card with `x402 services $0.0210`, `AI model calls $0.0066`, `Total spent $0.0276`. A cache-hit run (Vitalik) correctly showed all `$0.0000` (no synthesis ran). The `opts.llm ?? defaultLlm` wrapping fix above was found and fixed during this live verification — the first fresh run showed AI cost `$0.0000` until the default was wrapped.
