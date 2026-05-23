# Demo UI — Implementation Plan

**Scope:** a small Vite + React single-page app that drives the existing backend (`/discover`, `/verify-agent`) and a new SSE endpoint (`/verify-agent-stream`) for live progress logs. Pure demo surface — no auth, no routing, one page.

**Grounding:**
- Brand palette: `docs/WARD-o.html` (`--bg #F5F2EC`, `--fg #1A1A1A`, `--muted #8A8888`, `--faint #D9D5CC`; safe `#3E8B57`, risk `#B0413E`)
- Existing routes: [src/routes/discover.ts](../../src/routes/discover.ts), [src/routes/verify_agent.ts](../../src/routes/verify_agent.ts)
- Verify flow with hook seams: [src/agent/verify.ts](../../src/agent/verify.ts), [src/agent/invoke_all.ts](../../src/agent/invoke_all.ts), [src/discovery/discover.ts](../../src/discovery/discover.ts)
- Types & schemas: [src/agent/types.ts](../../src/agent/types.ts), [src/discovery/types.ts](../../src/discovery/types.ts)

---

## 0. Endpoint choice — confirmed

- **Plan** button → `POST /discover` (returns `DiscoveryPlan` with `services[].priceUsdc` and `totalEstimatedCostUsdc`, no spend).
- **Execute** button → `POST /verify-agent-stream` (new SSE route, streams progress events then a final result frame).
- The "Execute without plan" UX path simply skips showing the plan card first; both buttons end up at the same streaming run.

The brief said "hit our invoke endpoint" — `/discover` is the route that actually returns the **estimate** shape (categories + prices, no USDC spent). `/invoke` runs the full paid pipeline. Using `/discover` for Plan and `/verify-agent-stream` for Execute keeps the two clicks cleanly separated: one is free, the other commits.

---

## 1. Layout — files this plan touches

```
web/                              (new — Vite + React TS project)
  package.json
  index.html
  vite.config.ts
  tsconfig.json
  .env.example                    (VITE_API_BASE_URL=http://localhost:8000)
  src/
    main.tsx
    App.tsx
    api.ts                        (fetch wrappers for discover / verify-stream)
    storage.ts                    (localStorage helpers for saved plan)
    theme.css                     (palette + base styles)
    components/
      Logo.tsx                    (WARD-o wordmark — inline SVG or text)
      InputForm.tsx               (address + chain + two buttons)
      PlanCard.tsx                (categories × prices + total)
      LogStream.tsx               (textual event log)
      VerdictCard.tsx             (categories × prices + verdict)

src/routes/verify_agent_stream.ts (new — SSE route)
src/routes/verify_agent_stream_test.ts (new)
src/agent/verify.ts               (add optional onEvent hook)
src/agent/invoke_all.ts           (add optional onEvent hook)
src/discovery/discover.ts         (add optional onEvent hook)
src/agent/events.ts               (new — VerifyEvent union type, emit helper)
src/main.ts                       (register the new route)
```

Eight tickets follow. They split into a **backend track** (B-1..B-3) and a **frontend track** (F-1..F-5). Backend lands first so the frontend has a real stream to render. Tickets must be implemented in order within each track; tracks may interleave once B-1 (event types) is done.

---

## B-1: Event type contract

**Why:** the frontend log panel needs a stable shape. Define it once before touching the agent code so both sides type-check against the same union.

**Files:**
- `src/agent/events.ts` (new)
- `src/agent/events_test.ts` (new — tiny — just exercises the discriminated union narrowing)

**Logic:**
- Export a `VerifyEvent` discriminated union (`type` field):
  - `{ type: "phase"; phase: "preflight" | "discover" | "invoke" | "synthesize"; status: "start" | "end"; at: string }`
  - `{ type: "log"; level: "info" | "warn" | "error"; message: string; at: string }`
  - `{ type: "service"; status: "start" | "ok" | "error" | "fallback"; category: string; resource: string; priceUsdc?: number; amountUsdc?: number; durationMs?: number; error?: string; at: string }`
  - `{ type: "plan"; services: Array<{ category: string; resource: string; priceUsdc: number; rationale: string }>; totalEstimatedCostUsdc: number; walletNetwork: "base" | "base-sepolia"; at: string }`
  - `{ type: "result"; payload: VerifyAgentResponseBody; at: string }` (the final SSE frame — same JSON the non-streaming `/verify-agent` returns)
  - `{ type: "error"; code: string; message: string; status?: number; at: string }`
- Export `type EventEmitter = (e: VerifyEvent) => void` and a `noopEmit` default.
- `at` is always `new Date().toISOString()`. Helper `now()` for tests to stub.

**Acceptance criteria:**
- `VerifyEvent` import compiles in `src/agent/verify.ts`, `src/agent/invoke_all.ts`, `src/discovery/discover.ts`.
- `noopEmit` accepts every variant without TS error.

**Validation commands:**
```bash
~/.deno/bin/deno check src/agent/events.ts src/agent/events_test.ts
~/.deno/bin/deno lint src/agent/events.ts src/agent/events_test.ts
~/.deno/bin/deno test --allow-read src/agent/events_test.ts
```

**Test spec (named cases):**
- `events_test.ts > discriminated union narrows by type field` — exhaustive `switch (e.type)` compiles with no `never` fall-through.

---

## B-2: Thread `onEvent` through verifyAgent / invokeAll / discover

**Why:** the SSE route needs a way to observe the pipeline. Today these functions are silent except for `console.warn`. Add an **optional** `onEvent` opt to each so existing callers and tests are untouched.

**Files:**
- `src/agent/verify.ts` (edit — add `onEvent?: EventEmitter` to `VerifyAgentOpts`; emit phase boundaries and a `plan` event after discover)
- `src/agent/invoke_all.ts` (edit — add `onEvent?` to `InvokeAllOpts`; emit `service start/ok/error/fallback` around each `invokeWithAlternates` call)
- `src/discovery/discover.ts` (edit — add `onEvent?`; emit phase boundaries and a `log` line for "fetched N candidates per category")
- `src/agent/verify_test.ts`, `src/agent/invoke_all_test.ts`, `src/discovery/discover_test.ts` (edit — one new test per file verifying emitted event sequence with a recording emitter)

**Logic / shape of emits:**
- `verifyAgent`:
  1. emit `{ type: "phase", phase: "discover", status: "start" }`
  2. call `discoverFn` (pass `onEvent` through)
  3. emit `{ type: "plan", services: plan.services, totalEstimatedCostUsdc, walletNetwork }`
  4. emit `{ type: "phase", phase: "discover", status: "end" }`
  5. same pattern around `invokeAllFn` (`"invoke"`)
  6. same pattern around `synthesizeFn` (`"synthesize"`); on synthesis error emit `{ type: "log", level: "error", message }` *before* falling back to stub verdict
- `invokeAll`: for every service attempt emit `start` with `{category, resource, priceUsdc}`, then `ok` with `{amountUsdc, durationMs}` or `error` with `{error}`. When falling through to an alternate, emit `fallback` for the failed one (the next `start` carries the alternate).
- `discover`: emit one `log` line per fetched category with candidate count.
- `EventEmitter` is invoked synchronously; emitting **must not throw** — wrap each call in `try {} catch {}` inside the agent code so a broken consumer cannot break the pipeline.

**Acceptance criteria:**
- Existing test suites pass unchanged (no required arg added; default `noopEmit`).
- New tests assert: for a happy-path mock run, the emitted sequence contains `phase:discover:start → plan → phase:discover:end → phase:invoke:start → service:start (×N) → service:ok (×N) → phase:invoke:end → phase:synthesize:start → phase:synthesize:end` in that order.
- For a synthesis-failure mock, the sequence includes `log:error` before `phase:synthesize:end`.

**Validation commands:**
```bash
~/.deno/bin/deno check src/agent/verify.ts src/agent/invoke_all.ts src/discovery/discover.ts
~/.deno/bin/deno lint src/agent/verify.ts src/agent/invoke_all.ts src/discovery/discover.ts
~/.deno/bin/deno test --allow-net --allow-env --allow-read --allow-write --allow-sys src/agent/verify_test.ts src/agent/invoke_all_test.ts src/discovery/discover_test.ts
```

**Test spec:**
- `verify_test.ts > onEvent emits phase boundaries for happy path`
- `verify_test.ts > onEvent emits log:error then phase:synthesize:end on synthesis failure`
- `verify_test.ts > onEvent thrown by consumer does not crash verifyAgent`
- `invoke_all_test.ts > onEvent emits service start/ok per resolved category`
- `invoke_all_test.ts > onEvent emits service fallback when primary errors and alternate succeeds`
- `discover_test.ts > onEvent emits phase boundaries and per-category candidate count`

---

## B-3: `POST /verify-agent-stream` SSE route

**Why:** wire the emitter to the wire. Server-Sent Events over a `POST` body — Hono's `streamSSE` helper handles the headers + chunk framing.

**Files:**
- `src/routes/verify_agent_stream.ts` (new)
- `src/routes/verify_agent_stream_test.ts` (new)
- `src/main.ts` (edit — `app.route("/verify-agent-stream", verifyAgentStreamRouter)`)

**Logic:**
1. Same `VerifyAgentRequestSchema` validation as `/verify-agent`.
2. Same pre-flight budget check; on `budget_exhausted` emit one `error` SSE frame with status 503 metadata and end the stream. (We *cannot* set HTTP status mid-stream — so the route returns 200 and conveys errors as an `error` event. Document this.)
3. Open `streamSSE` (from `hono/streaming`). Each emit becomes `await stream.writeSSE({ event: e.type, data: JSON.stringify(e) })`.
4. Run `verifyAgent(req, { budgetCeiling, onEvent })`.
5. On success emit one final `result` event carrying the same body shape the non-streaming `/verify-agent` returns; close the stream.
6. On thrown error (`WalletUnfundedError`, `SanctionsInvocationError`, `DiscoveryFetchError`, missing `AGNIC_API_KEY`, generic) emit one `error` event with the same `code` strings used by `/verify-agent` and close.
7. Keep-alive: send a comment-line ping every 15s while the run is in flight (`stream.writeSSE({ data: "", event: "ping" })`). Cancel the timer on close.
8. The route accepts an optional `budgetFetcher` test seam mirroring `createVerifyAgentRouter`.

**Acceptance criteria:**
- `curl -N -X POST localhost:8000/verify-agent-stream -H "Content-Type: application/json" -d '{"address":"0x..","chain":"base"}'` prints `event:` and `data:` lines, ending with `event: result`.
- Invalid body returns 400 with zod error (before the stream opens — zValidator handles this).
- A budget-exhausted preflight emits exactly one `error` event then closes.

**Validation commands:**
```bash
~/.deno/bin/deno check src/routes/verify_agent_stream.ts src/routes/verify_agent_stream_test.ts src/main.ts
~/.deno/bin/deno lint src/routes/verify_agent_stream.ts src/routes/verify_agent_stream_test.ts
~/.deno/bin/deno test --allow-net --allow-env --allow-read --allow-write --allow-sys src/routes/verify_agent_stream_test.ts
```

**Test spec:**
- `verify_agent_stream_test.ts > streams phase, plan, service, result events in order` — uses a `verifyAgent` test seam that synchronously calls `onEvent` with a canned script; asserts the SSE body parses into the expected event types in the expected order.
- `verify_agent_stream_test.ts > preflight budget exhausted emits one error event and ends` — `budgetFetcher` returns `{ totalBalance: 0 }`; asserts a single `event: error` frame with `code: "budget_exhausted"`.
- `verify_agent_stream_test.ts > WalletUnfundedError emits error event with code wallet_unfunded`
- `verify_agent_stream_test.ts > invalid body returns 400 before stream opens`

---

## F-1: Vite + React scaffold under `web/`

**Why:** isolated Node toolchain. Backend stays Deno; frontend is its own world.

**Files:**
- `web/package.json` — deps: `react`, `react-dom`; devDeps: `vite`, `@vitejs/plugin-react`, `typescript`, `@types/react`, `@types/react-dom`, `eslint` (optional, skip if it bloats — Vite scaffold doesn't ship it by default).
- `web/vite.config.ts` — react plugin; dev server `port: 5173`; proxy `/discover`, `/verify-agent-stream`, `/health` to `http://localhost:8000` (so the frontend can fetch same-origin and avoid CORS surprises in demos).
- `web/tsconfig.json` — `strict: true`, `jsx: "react-jsx"`, `module: "ESNext"`, `moduleResolution: "bundler"`.
- `web/index.html` — title `WARD-o`, favicon optional.
- `web/src/main.tsx` — renders `<App />` into `#root`.
- `web/src/App.tsx` — placeholder ("hello"); real wiring lands in F-2..F-5.
- `web/src/theme.css` — `:root { --bg/--fg/--muted/--faint/--safe/--risk }` matching the deck. Base body: `background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, sans-serif;`
- `web/.env.example` — `VITE_API_BASE_URL=` (blank → uses Vite proxy in dev; set explicitly for prod builds).
- Root `.gitignore` — add `web/node_modules`, `web/dist`, `web/.env`.

**Logic:**
- Use the Vite `react-ts` template structure; no SSR, no router, no UI library.
- Add a `web/README.md` with two commands: `npm install`, `npm run dev`.

**Acceptance criteria:**
- `cd web && npm install && npm run dev` starts Vite on `:5173` and the placeholder page renders with the deck palette.
- `npm run build` produces a `dist/` with no type errors.
- The backend dev server on `:8000` is reachable from the frontend dev server via the proxy (`fetch("/health")` returns `{status:"ok"}` in the browser console).

**Validation commands:**
```bash
cd web && npm install
cd web && npm run build
cd web && npx tsc --noEmit
```

**Test spec:** no unit tests for scaffold. Manual smoke: load `http://localhost:5173`, confirm palette and proxy. Document the smoke steps in `web/README.md`.

---

## F-2: Input form + Plan card (calls `/discover`)

**Files:**
- `web/src/api.ts` — `discover(address, chain): Promise<DiscoverResponse>` (chain is accepted but not sent — `/discover` doesn't take chain; we store it for the later verify call).
- `web/src/components/Logo.tsx` — `WARD-o` wordmark, large at top of page. Plain text styled with the deck typography is fine.
- `web/src/components/InputForm.tsx` — controlled `<input>` for address, `<select>` for chain (`eth|base|polygon|arbitrum|optimism`), two `<button>`s: **Plan** and **Execute**. Validate address client-side with the same regex `/^0x[0-9a-fA-F]{40}$/`; disable both buttons while a request is in flight.
- `web/src/components/PlanCard.tsx` — renders `services[]` as a list (category · resource · `$priceUsdc`) plus a total. Show `walletNetwork` and `unresolvedCategories` (if any) as muted text.
- `web/src/App.tsx` — wire state: `address`, `chain`, `plan | null`, `loadingPlan`, `planError`.

**Logic:**
- Plan click → `POST /discover` with `{address, categories?}` (omit categories — defaults are fine).
- On 402 `wallet_unfunded`, render a friendly error panel with both wallet addresses (the response carries them).
- On 5xx, show the error message and a retry button.
- Plan card sits below the form; appears only when `plan` is non-null.

**Acceptance criteria:**
- Typing a valid address + clicking Plan shows a card listing each category and its `$priceUsdc`, plus the total.
- Typing an invalid address disables the Plan button and shows a one-line hint under the input.
- A 402 response renders the wallet-unfunded panel instead of the plan card.

**Validation commands:**
```bash
cd web && npx tsc --noEmit
cd web && npm run build
```

**Test spec:** manual smoke against a running backend, recorded in `web/README.md`:
- `valid address → plan card with N rows and total`
- `invalid address → button disabled, hint shown`
- `unfunded wallet → error panel with both addresses` (use a known-empty test wallet)

(No unit tests for F-2..F-5 — this is demo UI; type-check + manual smoke is the gate, matching repo norms.)

---

## F-3: Persist plan to localStorage

**Files:**
- `web/src/storage.ts` — `saveLastPlan(plan)`, `loadLastPlan(): Plan | null`, `clearLastPlan()`. Single key `wardo.lastPlan`. Wrap JSON parse in try/catch — corrupt data → `null`.
- `web/src/components/PlanCard.tsx` (edit) — add a **Save** button; on click call `saveLastPlan` and flip a "saved ✓" tag for 2s.
- `web/src/App.tsx` (edit) — on mount, hydrate state from `loadLastPlan()` so a refresh restores the last plan and pre-fills the form (address + chain captured alongside the plan).

**Logic:**
- Stored object: `{ address, chain, plan, savedAt }`. The address+chain are part of the saved record so Execute knows what to run against.

**Acceptance criteria:**
- Run Plan, click Save, refresh page → plan card and form are restored.
- Run Plan, click Save, run Plan again with a different address → card updates but localStorage still holds the original until Save is clicked again. (Save is explicit, not automatic.)

**Validation commands:** `npx tsc --noEmit` in `web/`.

**Test spec:** manual smoke entries in `web/README.md`:
- `save → reload → restored`
- `save → plan again without saving → reload → previous still restored`

---

## F-4: Streaming log panel (consumes `/verify-agent-stream`)

**Files:**
- `web/src/api.ts` (edit) — `streamVerify(address, chain, onEvent, signal)` that uses `fetch(..., { method: "POST", body, signal })`, then iterates `response.body!.getReader()` parsing SSE frames (`event:` / `data:` lines, blank-line separator). For each frame call `onEvent(parsed)`.
- `web/src/components/LogStream.tsx` — auto-scrolling `<div>` styled as a terminal (`font-family: ui-monospace`, `font-size: 12px`, `var(--faint)` background, `var(--fg)` text). Each line: `HH:MM:SS  [level/phase]  message`. Render `service:*` events as `· category · resource · $price` lines.
- `web/src/App.tsx` (edit) — Execute click → clears prior log + verdict, opens stream, appends each event to a `logs` array, and when a `result` event arrives stores the payload for the verdict card.

**Logic:**
- Use a single `AbortController` per run so navigating away or clicking Execute again cancels in-flight readers.
- An `error` frame appends a red line and ends the run.
- A `ping` frame is ignored (keep-alive only).
- Show a small "running…" pill in the form area while the stream is open.

**Acceptance criteria:**
- Click Execute → log panel fills line-by-line as the backend emits phases/services.
- Aborting (click Execute again) cancels the previous stream — no double-rendering after the second run starts.
- A `wallet_unfunded` error frame renders one red line and stops; verdict card does not appear.

**Validation commands:** `npx tsc --noEmit`, `npm run build` in `web/`.

**Test spec:** manual smoke entries:
- `happy path → see phase/service/result lines, then verdict appears`
- `mid-run re-execute → first stream stops, second run starts cleanly`
- `error frame → red line + no verdict card`

---

## F-5: Verdict card

**Files:**
- `web/src/components/VerdictCard.tsx` — header is the verdict label (`safe` / `risky` / `insufficient_data`) using `--safe` / `--risk` text color. Below: one row per receipt (`category · resource · paid $amountUsdc · status`) and the `totalSpentUsdc` line. Footer: the `headline` and `reasoning` from the verdict.
- `web/src/App.tsx` (edit) — render `VerdictCard` when the `result` event payload is present.

**Logic:**
- Same visual rhythm as `PlanCard` so the two read as a "before / after" pair.
- If `synthesisError` is set, render the synthesis error in muted text above the headline so the demo can show the conservative-stub path honestly.

**Acceptance criteria:**
- After a successful Execute run, the verdict card renders below the log panel, color-coded by `safe` flag.
- Receipts show the actual `amountUsdc` (paid) and `durationMs`, not the pre-call estimate.
- A synthesis-failure run still renders the card with the stub verdict + the error string surfaced.

**Validation commands:** `npx tsc --noEmit`, `npm run build` in `web/`.

**Test spec:** manual smoke:
- `safe verdict → green label`
- `risky verdict → red label`
- `synthesis-failure run → stub verdict + error line shown`

---

## Implementation order

1. **B-1** event types (5 min, unblocks everything else)
2. **B-2** wire `onEvent` through verify / invokeAll / discover (with tests)
3. **B-3** `/verify-agent-stream` SSE route (with tests + register in main.ts)
4. **F-1** Vite scaffold
5. **F-2** input + plan card via `/discover`
6. **F-3** localStorage persistence
7. **F-4** streaming log panel
8. **F-5** verdict card

Frontend tickets F-2..F-5 are demo-grade — type-check + manual smoke is the bar, no unit tests (matches repo norms for purely visual code).

## Out of scope

- Auth, multi-user, persistence beyond localStorage.
- Mobile / responsive polish beyond "doesn't break on a laptop".
- Re-running just one category, editing the plan, comparing two addresses.
- A "share this verdict" URL.
- Any production build / hosting steps — `npm run dev` is the demo runtime.

## Risks / call-outs

- **Hono streaming**: confirm `streamSSE` is exported from `jsr:@hono/hono@^4.7.11/streaming` in the version we pin. If not, fall back to manual `c.body(new ReadableStream(...))` with `Content-Type: text/event-stream`.
- **CORS for streaming**: existing `cors()` middleware should pass through, but SSE responses must include `Cache-Control: no-cache` and `Connection: keep-alive`. Verify in B-3.
- **SSE over POST**: `EventSource` cannot POST, so the frontend uses `fetch` + manual SSE parsing. This is the intentional cost of not stuffing the request into the URL.
- **Synchronous emit contract**: B-2 requires emitters be invoked synchronously and not awaited. If we ever need async emit (e.g. forwarding to a queue), revisit — but for in-process SSE, sync is fine and avoids ordering bugs.
