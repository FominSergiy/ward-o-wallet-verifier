## event-schema-overhaul

**What:** Adds structured telemetry fields to the event types emitted throughout the verify pipeline — every PhaseEvent and ServiceEvent now carries a `request_id` (for log correlation) and `duration_ms` (for latency tracking); ServiceEvent gains `cost_usd: number | null`; LogEvent is a discriminated union that requires `code` on error-level logs.

**Files:**
- `src/agent/events.ts` — type changes to PhaseEvent, ServiceEvent, LogEvent
- `src/agent/verify.ts` — request_id propagation, phase timing, error log code
- `src/agent/invoke_all.ts` — request_id propagation, service event timing + cost_usd
- `src/discovery/discover.ts` — request_id added to DiscoverOpts
- `src/routes/verify_agent.ts` — generates request_id via crypto.randomUUID()
- `src/routes/verify_agent_stream.ts` — generates request_id via crypto.randomUUID()
- `src/agent/events_test.ts` — new compile-time and integration tests
- `src/agent/verify_test.ts` — durationMs → duration_ms rename
- `src/routes/verify_agent_stream_test.ts` — all canned events updated with required fields

**Config:** None.

**Notes:**
- `duration_ms` on "start" events is always 0; completion events measure actual wall-clock time
- `cost_usd` is null for free/direct services (Chainalysis oracle, ENS, viem); set to `amountUsdc` for paid x402 calls
- Old optional `durationMs` field removed from ServiceEvent (breaking rename to `duration_ms`)
- If `request_id` is not provided to `verifyAgent`, one is auto-generated via `crypto.randomUUID()`
