# Wire `usage_events` writer + fix `api_key_id` attribution, with a post-deploy prod E2E

## Context

A live end-to-end test of the hosted product (mint key → deep check via hosted
`/mcp` → inspect prod DB) surfaced two telemetry gaps in production
(Neon project `super-grass-68246474`, branch `production`):

1. **`usage_events` is never written.** The table exists (created in
   `db/migrations/0001_init.sql:41`, typed as `UsageEventRow` in
   `src/db/types.ts:29`, tagged "metered billing/telemetry stream W1.2") but has
   **0 rows, ever**. The only code that touches it is a round-trip *test*
   (`src/db/client_test.ts:38`) — there is **no production writer**. This is the
   per-request trace stream (route / phase / verdict / cost / tenant), distinct
   from the per-service-call `service_observations`.

2. **`api_key_id` attribution on `service_observations` never populates.**
   `0 of 158` rows have a non-null `api_key_id` — including the keyed deep check
   we just ran through the hosted MCP (2026-06-30 15:38Z, $0.012, 4 service rows,
   all `api_key_id = NULL`). The column (`db/migrations/0005…`) and the
   `runWithApiKey(...)` wiring (`src/observability/request_context.ts`,
   `src/observability/observations.ts:24`) exist, but the id is lost before the
   write.

   **Leading root cause (verify, don't assume):** the ambient key id is carried
   via `AsyncLocalStorage`. The REST path deliberately wraps *the actual pipeline
   call* — `await runWithApiKey(id, () => runVerify(...))` in
   `src/routes/verify_agent.ts` — because, per the comment in
   `src/routes/key_attribution.ts`, "the SSE route runs the pipeline inside a
   stream callback that can outlive next()". The **MCP** path
   (`src/mcp/http.ts:103`) instead wraps `transport.handleRequest(c.req.raw)`,
   which returns the SSE `Response` *before* the tool body (`verifyAgent`)
   executes — so the tool runs **outside** the ALS scope and
   `currentApiKeyId()` reads `null`. (Web-UI REST runs may also be anonymous if
   `VITE_WARDO_WEB_KEY` isn't set in prod — confirm separately so you don't
   conflate the two.)

**Goal:** populate `usage_events` per request, make `api_key_id` (and
`tenant_id`) attribution actually land on both the REST and MCP paths, and add a
post-deploy E2E that runs against live prod to prove both, so this can't silently
regress again.

---

## A. `usage_events` writer

Add a fire-and-forget per-request writer mirroring the existing
`recordServiceObservation` shape, and emit one row at the terminal verdict of a
verify run.

**Design**
- New `src/observability/usage.ts` → `recordUsageEvent(...)`: a single
  `INSERT INTO usage_events (tenant_id, request_id, route, phase, duration_ms,
  cost_usd, verdict)` wrapped in `Promise.resolve(db\`…\`).catch(log.error)` —
  same non-blocking, never-throws contract as `observations.ts`.
- `tenant_id` comes from ambient context. Extend
  `src/observability/request_context.ts` to also carry `tenantId` (the
  `RequestContext` interface, `runWithApiKey` → `runWithRequestContext(apiKeyId,
  tenantId, fn)` or add a parallel `currentTenantId()`), since
  `ResolvedKey` already returns `tenantId` (`src/auth/api_keys.ts:28`) but
  `resolveApiKeyId` currently discards it (`src/routes/key_attribution.ts`
  returns only `id`).
- Call `recordUsageEvent` once per request at the end of the verify pipeline —
  prefer a single call site inside `verifyAgent` (`src/agent/verify.ts`) keyed on
  the `request_id` already threaded there, so REST **and** MCP both get a row for
  free. `route` = e.g. `verify-agent` / `mcp:get_deep_verdict`; `verdict` =
  `result.verdict`; `cost_usd` = `result.totalSpentUsdc`; `phase`/`duration_ms`
  as available.

**Acceptance criteria**
- A deep verify run (any path: REST `/verify-agent`, SSE, or MCP
  `get_deep_verdict`) writes exactly one `usage_events` row carrying the run's
  `request_id`, a non-null `route`, the final `verdict`, and `cost_usd` matching
  `totalSpentUsdc`.
- Keyed runs set `tenant_id` to the calling key's tenant; anonymous runs leave it
  `NULL`. A DB/write failure is logged and never breaks or slows the verdict.
- `deno task test` (offline replay) stays green and offline.

**Files:** `src/observability/usage.ts` (new), `src/observability/usage_test.ts`
(new), `src/observability/request_context.ts`, `src/routes/key_attribution.ts`,
`src/agent/verify.ts` (or the route call sites), `src/db/types.ts` (reuse
`UsageEventRow`).

**Validation**
```
~/.deno/bin/deno check src/observability/usage.ts src/observability/usage_test.ts
~/.deno/bin/deno lint  src/observability/usage.ts src/observability/usage_test.ts
~/.deno/bin/deno test --allow-net --allow-env --allow-read --allow-write src/observability/usage_test.ts
deno task test   # full offline replay still green
```

**Test spec** (`src/observability/usage_test.ts`, hermetic — inject a fake
`db`/recorder, no live DB):
- `writes one row with request_id, route, verdict, cost_usd on a terminal run`
- `sets tenant_id from ambient context when keyed; NULL when anonymous`
- `never throws and logs once when the insert rejects`
- `does not write before a terminal verdict` (no row on a pure start/in-flight
  event, mirroring the `service_observations` "start" skip)

---

## B. Fix `api_key_id` (and `tenant_id`) attribution on the MCP path

**Acceptance criteria**
- A deep check via the hosted `/mcp` with an issued key produces
  `service_observations` rows whose `api_key_id` equals that key's id (no longer
  `NULL`), and a `usage_events` row whose `tenant_id` equals the key's tenant.
- The REST `/verify-agent` path attributes correctly too — add a regression test
  if one doesn't already cover it. (If REST is already correct, scope the code
  change to the MCP transport.)
- Document/confirm whether prod runs the attribution build and whether
  `VITE_WARDO_WEB_KEY` is configured, so anonymous web runs aren't mistaken for a
  bug.

**Fix direction** (`src/mcp/http.ts`): wrapping `transport.handleRequest()` does
not keep the tool body inside the ALS scope. Make attribution survive the
streaming boundary — e.g. resolve `{apiKeyId, tenantId}` from the bearer up front
(as REST does) and bind it into the per-session/tool execution context so the
`get_deep_verdict`/`verify_wallet` handler runs with it in scope, rather than
relying on `runWithApiKey` around `handleRequest`. Confirm the chosen mechanism
actually carries through to `recordServiceObservation` and `recordUsageEvent`.

**Files:** `src/mcp/http.ts`, `src/mcp/server.ts` (tool handlers, if context must
be threaded there), `src/observability/request_context.ts`, plus tests below.

**Validation**
```
~/.deno/bin/deno check src/mcp/http.ts src/mcp/http_test.ts
~/.deno/bin/deno lint  src/mcp/http.ts src/mcp/http_test.ts
~/.deno/bin/deno test --allow-net --allow-env --allow-read --allow-write --allow-sys src/mcp/
deno task test
```

**Test spec** (`src/mcp/http_test.ts`, hermetic — stub `lookupApiKey` and capture
what `currentApiKeyId()`/`currentTenantId()` resolve to inside the tool handler):
- `tool handler observes the resolved apiKeyId/tenantId in ambient context`
  (the bug: today it observes null) — assert the captured id equals the stubbed
  key id across the SSE/streaming boundary
- `anonymous (no/invalid bearer) → null apiKeyId/tenantId in handler scope`
- `admin shared-secret bearer → authorized with null apiKeyId` (unchanged
  contract from `authorizeMcp`)

---

## C. Post-deploy prod E2E (runs against live prod)

A gated smoke test that proves the wiring on the real deployment after each
deploy. It mints a key, runs a deep check against prod, then reads the prod DB to
assert both fixes. **Makes real x402 paid calls (~$0.01–0.05 USDC) and hits live
prod + prod DB** — must self-gate so the default `deno task test` stays offline.

**Design**
- New `src/routes/prod_e2e_test.ts` (or `scripts/prod-smoke.ts` runnable via a
  `deno task smoke:prod`), self-gated on `RUN_PROD_E2E=1` (distinct from
  `RUN_E2E`, which is the local paid pipeline). `ignore: !Deno.env.get(...)` so it
  stays skipped by default — same pattern as the existing route suites.
- Inputs from env: `PROD_BASE_URL` (default `https://wallet-verifier.ward-o.deno.net`)
  and DB read access — reuse the `mcp__neon__run_sql` path conceptually, but in a
  Deno test use a read-only `DATABASE_URL` pointed at the `production` branch (or
  a thin Neon REST query). Keep prod creds out of the repo.
- Flow:
  1. `POST {PROD_BASE_URL}/request-key` → capture `apiKey` + `prefix`.
  2. Run a deep check with that key — drive `{PROD_BASE_URL}/mcp`
     (`initialize` → `notifications/initialized` → `tools/call get_deep_verdict`)
     against a known-safe fixture address, OR `POST /verify-agent` with the
     `Authorization: Bearer` header. Assert HTTP 200 + a valid verdict.
  3. Resolve the key's id/tenant: `SELECT id, tenant_id FROM api_keys WHERE
     key_prefix = $prefix`.
  4. Assert attribution + usage rows landed (poll a few seconds for the
     fire-and-forget writes):
     - `service_observations` has ≥1 row with `api_key_id = <key id>` created in
       the last ~2 min.
     - `usage_events` has ≥1 row with `tenant_id = <key tenant>`, non-null
       `verdict`, created in the last ~2 min.

**Acceptance criteria**
- With `RUN_PROD_E2E=1` + creds set, the test passes against a correctly
  deployed prod: verdict returned, attributed `service_observations` row present,
  `usage_events` row present.
- With the env unset, the test is skipped and `deno task test` is unchanged
  (offline, green).
- The test cleans up after itself where possible (the minted key can be left;
  note it's an attribution handle, not a paywall) and never asserts on
  pre-existing rows (scopes to its own key/tenant + a recent time window).

**Files:** `src/routes/prod_e2e_test.ts` (new) or `scripts/prod-smoke.ts` (new) +
a `deno task` entry in `deno.json`; `.env.example` (document `RUN_PROD_E2E`,
`PROD_BASE_URL`, and the read-only prod DB var); `docs/deployment.md` (add a
"post-deploy smoke" note).

**Validation**
```
~/.deno/bin/deno check src/routes/prod_e2e_test.ts
~/.deno/bin/deno lint  src/routes/prod_e2e_test.ts
deno task test                 # test stays SKIPPED + offline (no RUN_PROD_E2E)
# Post-deploy, manual/CI, against live prod (real USDC):
RUN_PROD_E2E=1 PROD_BASE_URL=https://wallet-verifier.ward-o.deno.net \
  DATABASE_URL=<prod-readonly> ~/.deno/bin/deno test --allow-net --allow-env src/routes/prod_e2e_test.ts
```

**Test spec** (`src/routes/prod_e2e_test.ts`, gated on `RUN_PROD_E2E`):
- `mints a key and a keyed deep check returns a valid verdict from prod`
- `the deep check writes service_observations attributed to the minted key`
- `the deep check writes a usage_events row for the minted key's tenant`
- `skipped entirely when RUN_PROD_E2E is unset` (guard assertion / `ignore`)

---

## Cassette note (per CLAUDE.md cutover rule)

A/B are **downstream of the HTTP calls** (telemetry writes, context plumbing,
transport wiring) — they do **not** change which URLs are called or their
method/query/path/body. So **no `cassette:record`** is required; `deno task test`
(replay) remains the gate. Re-record only if a wallet fixture or a service
request shape changes. C exercises live prod directly and uses no cassettes.

## Out of scope
- Backfilling `api_key_id`/`usage_events` for the 158 historical rows.
- Billing/metering logic on top of `usage_events` (this ticket only lands the
  stream; W1.x metering builds on it).
- Per-isolate MCP session durability on multi-replica Deno Deploy (noted in
  `src/mcp/http.ts:54`) — separate concern.
