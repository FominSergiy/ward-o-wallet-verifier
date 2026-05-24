# Post-v8 hygiene — planned follow-ups

**Why this exists:** captured during a holistic review on 2026-05-23 after the
v8 real-wallet run hit 9/9 verdict accuracy and 96% primary-pick reliability.
Demo-ready signal is solid; these are the medium/low-severity items that
would sand down rough edges before opening the service up to outside users.
They were intentionally deferred from the lint/holistic-review pass so the
demo branch could stay focused on must-fix correctness.

Items are independent — pick them off one at a time. Each has its own
acceptance criteria. None blocks the others.

---

## P-1: Durable-block the broken Orbis `:endpoint` variant

**Why:** [data/service_health.json](../../../data/service_health.json) shows
`https://orbisapi.com/proxy/wallet-address-risk-api-c6680c/:endpoint` with
1/1 errors (`non_json_response` — service returns HTML on POST). v8 receipts
confirm this is also our 104 s latency outlier. The non-`:endpoint` variant
of the same service works and must remain rankable.

**Files:**

- [src/discovery/health_store.ts](../../../src/discovery/health_store.ts)
  — extend `isDurablyBlocked()` (or its underlying rule set) to match the
  `:endpoint` literal suffix on this Orbis URL.
- [src/discovery/health_store_test.ts](../../../src/discovery/health_store_test.ts)
  — add a test asserting the suffix variant is blocked while the bare URL is not.

**Acceptance:**
- `isDurablyBlocked("https://orbisapi.com/proxy/wallet-address-risk-api-c6680c/:endpoint")` returns `true`.
- `isDurablyBlocked("https://orbisapi.com/proxy/wallet-address-risk-api-c6680c")` returns `false`.
- Next live discovery run no longer ranks the `:endpoint` variant.

**Validation:** `~/.deno/bin/deno test src/discovery/health_store_test.ts`.

---

## P-2: Expose `discover` and `invoke` as MCP tools

**Why:** [src/mcp/server.ts](../../../src/mcp/server.ts) currently exposes only
`verify_wallet`. For the hackathon "service self-discovery" pitch, an MCP
consumer should be able to call `discover` first (free, returns a plan +
cost estimate) and then `invoke` against that plan. Mirrors the existing
HTTP routes [src/routes/discover.ts](../../../src/routes/discover.ts) and
[src/routes/invoke.ts](../../../src/routes/invoke.ts).

**Files:**

- `src/mcp/server.ts` — register two new tools: `discover_services(address)`
  and `invoke_services(plan, opts?)`. Reuse the Zod schemas from
  `src/agent/types.ts` and `src/discovery/types.ts`.
- `scripts/mcp_e2e.ts` — extend smoke script to exercise both new tools.

**Acceptance:**
- `discover_services` returns a `DiscoveryPlan` matching `/discover`.
- `invoke_services` accepts a `DiscoveryPlan` and returns the same shape as
  `/invoke`.
- `scripts/mcp_e2e.ts` runs all three tools against vitalik.eth end-to-end.

**Validation test spec:**
- Test case: tool registration includes `discover_services` and `invoke_services`.
- Test case: schema validation rejects malformed plan in `invoke_services`.
- Test case: mocked `discover` and `invokeAll` produce expected MCP responses.

---

## P-3: MCP transport unit tests

**Why:** `src/mcp/{stdio,http,server}.ts` are only exercised by the
`scripts/mcp_e2e.ts` smoke script, which is not part of `deno task test`.
Regressions in tool schemas or transport plumbing won't be caught by CI.

**Files:**

- `src/mcp/server_test.ts` — tool registration + schema validation.
- `src/mcp/stdio_test.ts` — bootstrap + tool call round-trip against an
  in-memory transport pair.
- `src/mcp/http_test.ts` — HTTP handler accepts JSON-RPC tool calls.

**Acceptance:** `deno task test` includes the new files and they pass.

**Validation:** `~/.deno/bin/deno test --allow-net --allow-env --allow-read --allow-write --allow-sys src/mcp/`.

---

## P-4: Structured streaming `log` events

**Why:** `log` events emitted by `/verify-agent-stream` and
`/discover-stream` carry a free-form `message: string`; clients have to
regex-parse to extract things like `category_skipped` or `fallback_used`.
A small discriminated union would let UI and external consumers handle
events without string parsing.

**Files:**

- [src/agent/events.ts](../../../src/agent/events.ts) — define a typed
  union covering the existing emission sites (`category_skipped`,
  `fallback_used`, `labels_registry_failed`, `synthesis failed`, etc.).
- Every `safeEmit(..., { type: "log", ... })` site in `src/agent/verify.ts`,
  `src/agent/invoke_all.ts`, `src/agent/invoke_service.ts`,
  `src/discovery/*` — migrate to the typed event.
- [web/src/types.ts](../../../web/src/types.ts) and
  [web/src/components/LogStream.tsx](../../../web/src/components/LogStream.tsx) —
  consume the typed shape.

**Acceptance:** no free-form `log.message` strings remain on the backend
event stream; the frontend renders the same UX without regex matching.

---

## P-5: Request-ID propagation across invocations

**Why:** `invokeAll`'s parallel fan-out gives every service call its own
log lines, but there's no correlation ID tying them back to a single
verify run. Debugging real runs (especially the v8-style 9-wallet sweeps
via [scripts/test_wallets.ts](../../../scripts/test_wallets.ts)) means
manually correlating timestamps.

**Files:**

- `src/agent/verify.ts` — mint a `runId` at the top of `verifyAgent`,
  thread it through `opts` to `invokeAll`, `discover`, and the chain-
  primitive helpers.
- `src/agent/events.ts` — add `runId` as an optional field on every event
  type.
- `src/clients/agnic.ts` — accept `runId` via opts and include it in
  thrown errors' messages for grep-ability.

**Acceptance:** every event emitted during a verify run carries the same
`runId`; a single grep on the dev-server log surfaces the full timeline
for one request.

---

## P-6: EIP-55 checksum validation on addresses

**Why:** `VerifyRequestSchema` in
[src/agent/types.ts](../../../src/agent/types.ts) accepts any 40-hex
string. A hand-typed address with a swapped digit will pass validation
and produce a confusing "wallet not found" verdict instead of a clear
"invalid checksum" error.

**Files:**

- `src/agent/types.ts` — add a `.refine()` to `VerifyRequestSchema`
  using viem's `isAddress(addr, { strict: true })` (or equivalent
  checksum check). Make it optional/warn-only if the address is all
  lowercase (developers commonly paste lowercase).
- `src/agent/types_test.ts` (new) — assertions for valid checksum,
  invalid checksum (mixed case but wrong), and all-lowercase (allowed).

**Acceptance:** a mixed-case address with a swapped checksum nibble
produces a 400 response with an `invalid_checksum` error code; an
all-lowercase address still passes.

---

## Out of scope for this batch

- Replacing `console.warn` with structured logging library — defer until
  there's a deployment target that consumes structured logs.
- Persisting `data/service_health.json` to a database — single-process
  Deno is fine for the hackathon and demo footprint.
