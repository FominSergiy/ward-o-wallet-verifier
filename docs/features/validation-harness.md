# validation-harness

**What:** Sharpens the repo's agent-validation tooling (type-check coverage, test task split, a typed wallet fixture, and an auto-format/lint hook) so agent edits get truthful feedback. No runtime/behavior change.

**Files:**
- `deno.json` — `check` task now `deno check src/**/*.ts` (was two entrypoints); added `test:unit` and `test:e2e` tasks.
- `CLAUDE.md` — Project tools table documents the test split + the `RUN_E2E` paid-route gate; module map lists `fixtures/wallets.ts`.
- `src/fixtures/wallets.ts` (new) — `WALLET_FIXTURES`: 9 canonical address→`Verdict` cases, imports `Verdict` from `src/agent/verdict.ts`.
- `src/fixtures/wallets_test.ts` (new) — invariants: valid 0x-40-hex addresses, expected ∈ Verdict enum, addresses unique.
- `.claude/settings.json` — added a `PostToolUse` (`Edit|Write`) hook running `deno fmt`+`lint` on the single edited `.ts` file.

**Config:** none. `test:e2e` requires `AGNIC_API_KEY` + USDC balance (runs the 3 `RUN_E2E`-gated route suites: `src/routes/{discover,invoke,verify_agent}_test.ts`).

**Notes:**
- The hook is **deliberately scoped to the edited file**. An earlier `deno fmt src/` version reformatted 40+ unrelated files on the first edit (repo was not fmt-clean) — rejected. The hook parses the edited path from the PostToolUse stdin JSON (`tool_input.file_path`) via `python3` and only acts on `*.ts`.
- Fixture is **create-only**: existing unit tests that hardcode the same addresses (`ens_resolver_test.ts`, `sanctions_oracle_test.ts`, etc.) were intentionally not rewired.
- Fixture source of truth is `docs/real-wallet-tests/report_v8.md` (9/9 strict-match baseline). If verdicts drift in a later report, update the fixture.
- Hook changes in `settings.json` may need a session reload to take effect in the harness.
