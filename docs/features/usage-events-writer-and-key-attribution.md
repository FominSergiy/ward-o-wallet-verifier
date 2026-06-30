# usage-events-writer-and-key-attribution

**What:** Writes one `usage_events` trace row per verify run and makes
`api_key_id` / `tenant_id` attribution actually land on both the REST and MCP
paths, with a gated post-deploy prod E2E that proves both against live prod.

## Files

**Added**

- `src/observability/usage.ts` — `recordUsageEvent(event, db?)`: fire-and-forget
  `INSERT INTO usage_events`, mirroring `observations.ts` (non-blocking,
  never-throws, `db` injectable for tests). Reads `tenant_id` from ambient
  context; skips non-terminal events (`terminal: false`).
- `src/observability/usage_test.ts` — hermetic, fake-db value capture.
- `src/routes/prod_e2e_test.ts` — gated (`RUN_PROD_E2E=1`) live-prod E2E.

**Changed**

- `src/observability/request_context.ts` — context now carries `tenantId`;
  `runWithRequestContext(apiKeyId, tenantId, fn)` + `currentTenantId()` replace
  the apiKey-only `runWithApiKey` (removed).
- `src/routes/key_attribution.ts` — `resolveApiKeyId` → `resolveKeyContext`
  returning `{ apiKeyId, tenantId }`.
- `src/agent/verify.ts` — public `verifyAgent` wraps `verifyAgentImpl`, generates
  the request id once, and emits exactly one `usage_events` row at the terminal
  verdict (every path). New `route?` opt.
- `src/mcp/http.ts` — `authorizeMcp` returns `tenantId`; per-session auth
  `holder` stamped before each `handleRequest` and read by the tool at execution
  time (fixes the ALS-across-streaming-boundary leak). New `buildServer` test
  seam.
- `src/mcp/server.ts` — `buildMcpServer(…, getAuthContext?)`; both tool handlers
  re-establish the request context via `runWithRequestContext` so the writers
  attribute the run. New `McpAuthContext` type.
- `src/mcp/http_test.ts` — `authorizeMcp` tenant assertions + 3 integration
  tests driving a real MCP client → Hono → transport round-trip.
- `src/routes/verify_agent.ts`, `verify_agent_stream.ts`, `invoke.ts` — use
  `resolveKeyContext` + `runWithRequestContext`; pass `route`.
- `deno.json` — `smoke:prod` task. `.env.example`, `docs/deployment.md` —
  document `RUN_PROD_E2E` / `PROD_BASE_URL` + the post-deploy smoke.

## Config

- New env (all optional, only for the gated prod E2E): `RUN_PROD_E2E=1`,
  `PROD_BASE_URL` (default `https://wallet-verifier.ward-o.deno.net`), and
  `DATABASE_URL` pointed at the `production` branch (read-only suffices).
- No schema change — `usage_events` already exists (`0001_init.sql`), typed as
  `UsageEventRow`.

## Notes

- **No cassette re-record:** the changes are downstream of the HTTP calls
  (telemetry writes + context plumbing), so recorded traffic is unchanged —
  replay stays the gate (9/9 green).
- **Why the MCP path needed a holder, not ALS:** the streamable-HTTP transport
  returns its `Response` before the tool body executes, so an
  `AsyncLocalStorage` scope wrapped around `handleRequest()` does not enclose the
  tool. The per-session holder (set on every request, read at tool-execution
  time) bridges that boundary; the tool then re-establishes the ALS context for
  the fire-and-forget writers.
- **Anonymous web runs are not a bug:** if `VITE_WARDO_WEB_KEY` is unset in prod,
  web-UI REST runs are legitimately anonymous (`api_key_id` NULL) — distinct from
  the MCP attribution bug this fixed.
- **Out of scope:** backfilling the 158 historical rows; billing/metering on top
  of `usage_events`; multi-replica per-isolate MCP session durability.
- The prod E2E uses a non-sanctioned fixture on purpose — a `do_not_transact`
  address short-circuits on the free oracle with zero paid calls and would leave
  no attributed `service_observations` to assert on.
