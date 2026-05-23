# verify-agent-stream — backend half of the demo-ui plan

**What:** Adds a `POST /verify-agent-stream` Server-Sent-Events route that runs the same agent pipeline as `/verify-agent` and streams progress events (`phase`, `log`, `plan`, `service`, `error`) followed by a final `result` event. The pipeline itself was made observable by threading an optional `onEvent` callback through `verifyAgent`, `invokeAll`, and `discover`.

**Files:**
- `src/agent/events.ts` (new) — `VerifyEvent` discriminated union, `EventEmitter` type, `noopEmit`, `safeEmit`, `now()` helper.
- `src/agent/events_test.ts` (new) — union narrowing + safeEmit-swallows-exceptions.
- `src/agent/verify.ts` (edit) — `VerifyAgentOpts.onEvent?`; emits `phase` boundaries around discover/invoke/synthesize, a `plan` event after discover, and a `log:error` on synthesis failure before the stub-verdict fallback.
- `src/agent/invoke_all.ts` (edit) — `InvokeAllOpts.onEvent?`; emits `service start/ok/error/fallback` per attempt (including the viem onchain_history rescue).
- `src/discovery/discover.ts` (edit) — `DiscoverOpts.onEvent?`; emits `log` lines for detected wallet network + per-category candidate counts.
- `src/routes/verify_agent_stream.ts` (new) — Hono router using `streamSSE`; same pre-flight budget check as `/verify-agent`; queue+drain writer loop so emits stay in order; 15s ping keep-alive.
- `src/routes/verify_agent_stream_test.ts` (new) — happy-path ordering, preflight-budget error, WalletUnfundedError mapping, 400 on malformed body.
- `src/main.ts` (edit) — registers `/verify-agent-stream`.
- `deno.json` (edit) — adds `hono/streaming` import-map entry.
- `src/agent/verify_test.ts`, `src/agent/invoke_all_test.ts`, `src/discovery/discover_test.ts` (edit) — new tests for the emitted-event sequences.

**Config:** No new env vars. Pre-flight uses the existing `AGNIC_BUDGET_MIN_USD` (default `0.10`).

**Notes / gotchas:**
- Emits are synchronous and wrapped in `safeEmit` — a consumer that throws will not break the pipeline.
- SSE can't change HTTP status mid-stream. Budget-exhausted and wallet-unfunded are conveyed as a single `event: error` frame with the original status code in the `status` field; the HTTP response itself is 200.
- The route uses a manual emit-queue + drain loop instead of letting `streamSSE` write inline. This is so that synchronous emits from inside `verifyAgent` are guaranteed to appear in the order they were produced, regardless of how the underlying `streamSSE` writer schedules its flushes.
- `result` event's `payload` matches the JSON shape of the existing `/verify-agent` 200 response (verdict, plan, receipts, walletNetwork, totalSpentUsdc, synthesisError).
- E2E happy-path (`RUN_E2E=1 deno test … src/routes/verify_agent_test.ts`) was re-run after the changes — `/verify-agent` still returns `safe_to_transact` with `totalSpentUsdc ≈ $0.034` on the funded test wallet, confirming the `onEvent` plumbing didn't perturb the non-streaming path.

**Follow-ups (frontend track F-1..F-5 of `docs/plans/planned/demo-ui.md`):**
- Vite scaffold under `web/`.
- Input form + plan card calling `POST /discover`.
- localStorage plan persistence.
- Streaming log panel + verdict card consuming `POST /verify-agent-stream` via `fetch` + manual SSE parsing.
