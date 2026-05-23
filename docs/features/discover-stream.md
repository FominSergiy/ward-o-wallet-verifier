# discover-stream

**What:** A streaming `POST /discover-stream` SSE route that emits the same phase / log events the discover pipeline already produces, terminated by a `plan` frame; plus a two-tab terminal in the demo UI so Plan and Execute each keep their own log buffer (click to flip, no re-runs).

**Files:**
- `src/agent/events.ts` — `PlanEvent` gained optional `unresolvedCategories?: Category[]` (populated only by `/discover-stream`; `verify.ts` leaves it undefined).
- `src/routes/discover_stream.ts` (new) — `createDiscoverStreamRouter({ discoverFn? })`; copies the queue/drain/ping SSE pattern from `verify_agent_stream.ts`. Emits the final `plan` frame in the route (discover.ts doesn't emit it). Error mapping mirrors `/discover` but as SSE `error` events with `code` + `status`.
- `src/routes/discover_stream_test.ts` (new) — 3 cases: happy-path event ordering, `WalletUnfundedError` → `error` frame with `wallet_unfunded`, invalid body → 400 before stream opens.
- `src/main.ts` — registers `/discover-stream`.
- `web/vite.config.ts` — proxies `/discover-stream`.
- `web/src/api.ts` — extracted `consumeSSE(path, body, onEvent, signal)`; added `streamDiscover`; `streamVerify` reuses the same helper. Dropped the old non-streaming `discover()` client.
- `web/src/types.ts` — new `PlanView` type (UI projection of the streamed plan event); `SavedPlan.plan` is now `PlanView` not `DiscoveryPlan`.
- `web/src/components/PlanCard.tsx` — now takes `PlanView`.
- `web/src/components/TerminalTabs.tsx` (new) — wraps `LogStream`; renders a 2-tab strip ("plan" / "execute") with per-tab event count + running-dot pulse.
- `web/src/App.tsx` — split state into `planEvents` / `verifyEvents` with independent `AbortController`s and streaming flags; `handlePlan` now goes through `streamDiscover` and populates `plan` from the `plan` event.
- `web/src/theme.css` — `.terminal-tabs`, `.tab-strip`, `.tab.active`, `.dot` pulse.

**Config:** no new env vars. Vite dev proxy needs `/discover-stream`.

**Notes:**
- The `/discover` non-streaming route is unchanged and still registered — kept for any direct API consumer. The frontend no longer calls it.
- Memory cost of two tabs: each tab holds only the most-recent run (Plan ~7 events, Execute ~22 events). Roughly <10 KB total state; no growth across reruns since each click replaces its own slot.
- Auto-switch behavior: clicking Plan switches to the plan tab; clicking Execute switches to the execute tab. Users can flip manually after either run.
- Independent abort: clicking Plan again only cancels the in-flight Plan stream, not Execute (and vice versa).
- `unresolvedCategories` on `PlanEvent` is intentionally optional. `verify.ts` emits a mid-pipeline `plan` event for its own use; only `/discover-stream` populates the final-result field.
- E2E verified live in browser via Claude Preview against vitalik.eth: Plan tab filled with 7 events + plan card → Execute tab filled with 24 events (incl. fallback for web_sentiment) → "safe to transact" verdict → flipping between tabs preserves both logs.

**Follow-ups / known gaps:**
- `wallet_unfunded` over SSE doesn't ship `baseAddress` / `baseSepoliaAddress` (the panel relied on those from the JSON `/discover` body). The error frame's `message` carries the addresses as a string; the UI shows it as a red log line instead of the dedicated panel. Could be addressed by widening the `ErrorEvent` schema to carry an arbitrary `details` object.
- No keyboard shortcut for tab-flipping yet.
