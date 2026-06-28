# repo-drift-cleanup

**What:** A pre-feature housekeeping pass that fixed agent-facing documentation drift, centralized two scattered cross-cutting concerns (route error-dispatch and logging), and removed small frontend duplication/dead code. No behavior change.

## Files

Docs / harness:
- `CLAUDE.md` — fixed MCP surface (one tool → two: `verify_wallet` + `get_deep_verdict`); corrected LLM attribution (lives in `src/gateway.ts`, not `clients/agnic.ts`) and added `gateway.ts` to the module map; added `registry/`, `cache/`, `observability/`, `vetter/`, `testing/` to the module map; cut the stale "Best Practices" + Agnic curl section (replaced with a one-line pointer); clarified `test`/`test:unit` are aliases; softened "locked"/dated framing.
- `docs/agent-log.md`, `docs/features/neon-mcp.md` — backfilled the missing record for the `neon-mcp` feature (commit `040f48a`).

Backend — error dispatch (new shared helper, removes ~40 duplicated lines):
- `src/routes/errors.ts` (new) — `mapRouteError(e)` single source of truth for error→status mapping; `jsonErrorBody(m)` builder. Returns `null` for unowned errors (caller rethrows / emits `internal_error`).
- `src/routes/budget.ts` (new) — `budgetThreshold()` shared by both verify routes (was duplicated).
- `src/routes/{discover,invoke,verify_agent}.ts` — JSON routes now `mapRouteError` + `jsonErrorBody`.
- `src/routes/{discover_stream,verify_agent_stream}.ts` — stream routes map then emit the SSE `error` event (leaner code/status/message, `internal_error` fallback preserved).

Backend — logging (new module, replaces 41 scattered `console.*`):
- `src/observability/log.ts` (new) — `log.{debug,info,warn,error}`, single `<iso> LEVEL <message>` format, level gated by `LOG_LEVEL` (default `info`). No dependency.
- Swapped `console.*` → `log.*` across 13 files: `main.ts`, `gateway.ts`, `discovery/{rank,adapter}.ts`, `agent/{verify,invoke_all,invoke_service,ofac_list}.ts`, `observability/observations.ts`, `registry/select.ts`, `vetter/run.ts`, plus both verify routes.

Frontend:
- `web/src/utils.ts` (new) — canonical `fmtUsd` (was defined 4× with inconsistent rounding; standardized on 4-dp).
- `web/src/components/{PlanCard,VerdictCard,LogStream,FlowDiagram}.tsx` — import the shared `fmtUsd`, dropped local copies.
- `web/src/storage.ts` — removed dead `clearLastPlan` export.

Tests:
- `src/routes/errors_test.ts`, `src/routes/budget_test.ts`, `src/observability/log_test.ts` (new) — pin the new modules' contracts (+15 tests).

## Config

- `LOG_LEVEL` (optional, default `info`) — new env var controlling the logger's minimum level.

## Notes

- Deliberately **not** done (would be bloat): DB repository layer (the `getDb()` entry point is enough), unified non-x402 fetch wrapper, stream/non-stream route merging, frontend lint tooling. See the plan in `~/.claude/plans/` for the full out-of-scope rationale.
- No cassette re-record — none of these changes alter HTTP request shape (per the CLAUDE.md cutover rule).
- Verification: `deno check`/`deno lint`/`deno fmt --check` clean; `deno task test` 360 passed / 0 failed / 12 ignored; `deno task test:replay` 9/9; `web` typecheck + build clean.
