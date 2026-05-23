# demo-ui

**What:** Vite + React single-page demo that drives `POST /discover` and the SSE `POST /verify-agent-stream` route, showing a plan card (estimate, savable to localStorage), a live log panel for streamed phase/service events, and a verdict card with findings + receipts + total spent.

**Files:**
- `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`
- `web/.env.example`, `web/README.md`
- `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/storage.ts`, `web/src/types.ts`, `web/src/theme.css`, `web/src/vite-env.d.ts`
- `web/src/components/Logo.tsx`, `InputForm.tsx`, `PlanCard.tsx`, `LogStream.tsx`, `VerdictCard.tsx`
- `.claude/launch.json` (preview server config)
- `.gitignore` (web/node_modules, web/dist, web/.env)

**Config:**
- Node 22 / npm 11 toolchain (separate from Deno backend).
- `VITE_API_BASE_URL` env (blank in dev → uses Vite proxy to `:8000`).
- Vite proxies `/discover`, `/verify-agent`, `/verify-agent-stream`, `/health`.

**Notes:**
- SSE consumer uses `fetch` + `ReadableStream` reader; `EventSource` can't POST. Frames split on blank lines, parses `event:` / `data:`; `ping` frames discarded.
- Verdict shape comes from `src/agent/verdict.ts` (`verdict: "safe_to_transact" | "do_not_transact" | "insufficient_data"`, plus `safe: boolean`, `confidence`, `findings[]`, `coverage`). Verdict label color keyed off `verdict`, not `safe`.
- `streamVerify` sends `{ address, chain }` because `VerifyRequestSchema` requires `chain` (initially missed → 400; verified live and fixed).
- Plan save is explicit (Save button) — replanning without saving leaves the previous record in localStorage so refresh restores the last saved state.
- E2E smoke-verified in browser via Claude Preview against vitalik.eth: 4 services in plan → save → reload-restore → execute → 22 stream events (phase, service start/ok, plan, fallback for web_sentiment) → result event → green "safe to transact" verdict with findings + receipts + `$0.0339` total.

**Follow-ups / known gaps:**
- No unit tests for F-2..F-5 components (demo grade, matches repo norms).
- No "abort/cancel" UI — clicking Execute again abortControllers prior run, but there's no dedicated cancel button.
- Mobile layout untested; budget was "doesn't break on laptop."
