# Agent instructions

## GitHub

Use the `gh` CLI via Bash for all GitHub operations — PRs, issues, comments, reading files, checks, releases. Run it directly; it is authenticated on this machine and pre-approved for use here.

Do NOT use the `mcp__github__*` MCP tools — they have been flaky in practice.

Repo owner: `FominSergiy`, repo name: `ward-o-wallet-verifier`.

## agent docs

all lives under docs

### plans

to be executed plans are saved under plans/planned
all done plans are put under plans/completed


## Project tools

**Runtime:** Deno. Binary: `~/.deno/bin/deno`. All tasks are in `deno.json`.

| Task | Command |
|------|---------|
| Dev server (watch) | `deno task dev` |
| Run tests (offline-safe) | `deno task test` / `deno task test:unit` |
| Run tests incl. paid E2E | `deno task test:e2e` |
| Lint | `deno task lint` |
| Type-check | `deno task check` |
| Run DB migrations | `deno task db:migrate` (needs `DATABASE_URL`) |

`test` / `test:unit` skip the three `RUN_E2E`-gated route suites (`src/routes/{discover,invoke,verify_agent}_test.ts`) — those make real Agnic/x402 paid calls. `test:e2e` runs them and needs `AGNIC_API_KEY` + USDC balance.

### Cassettes: replay (free) vs record (paid) — READ BEFORE RECORDING

There are two cassette tasks and they are NOT interchangeable:

| Task | What it does | Cost | When |
|------|-------------|------|------|
| `deno task test:replay` (also part of `deno task test`) | Replays the saved HTTP responses in `tests/cassettes/` against the full `verifyAgent` pipeline. Fully offline — the interceptor *throws* on any un-recorded URL, so no real network and no spend. ~4s. | **Free** | Every change. This is the CI gate. |
| `deno task cassette:record` | Runs the real pipeline against all 9 wallet fixtures, making **real x402 paid calls (real USDC), real RPC calls, and real LLM calls**. Takes **~10–15 min** (60s per-call timeouts, 5s rate-limit backoffs, 3s inter-wallet sleeps, LLM-fallback double calls). | **Real money + slow** | Rarely — see rule below. |

**The cutover rule — only re-record when the recorded HTTP traffic itself would change.** Ask: *"Does my change alter which URLs get called, or the method / query / path / body of those calls?"*

- **YES → `cassette:record` is required.** Triggers: a service added/removed/reordered in the registry or `data/call_recipes.json`; a changed request shape (URL, method, params, body); a service's response schema changed such that you need fresh real responses; new or changed wallet fixtures (`src/fixtures/wallets.ts`).
- **NO → just `test:replay`, never record.** Everything downstream of the HTTP calls: verdict synthesis, scoring/ranking, formatting, types, error handling, refactors, new tests, frontend, docs, CI, DB schema. Same requests → same saved responses → replay still valid.

If replay fails after a logic-only change, the fix is the code or the assertion — **not** a re-record. Re-recording to make a red test green hides the regression.

When you do record: it **must** run with `DATABASE_URL` unset/empty (e.g. `DATABASE_URL="" deno task cassette:record`) so service selection takes the same offline fallback path as replay — otherwise the recorded set won't match what replay calls and every replay test breaks.

When working in a worktree or targeting specific files, use the binary directly:

```bash
~/.deno/bin/deno check <file>.ts <file>_test.ts
~/.deno/bin/deno lint <file>.ts <file>_test.ts
~/.deno/bin/deno test --allow-net --allow-env <file>_test.ts
```

Once a worktree's work is merged (or abandoned), clean it up — leftover worktrees under `.claude/worktrees/` accumulate as orphans. After confirming the worktree is clean and its branch is merged, run `git worktree remove <path>`, `git branch -D <branch>`, then `git worktree prune`.

### Parallel agents — worktree isolation (hard rule)

When more than one agent works in this repo at the same time, they must be fully isolated. There is no exception.

- **One feature request = one feature branch = one worktree.** Every feature gets its own `git worktree add .claude/worktrees/<slug> -b <feature-branch>` off an up-to-date `main`. Do the work there, not in the primary checkout.
- **Never two agents in the same worktree or on the same branch.** Do not share a working directory, do not commit to a branch another agent is using, and do not check out a branch that already has an agent on it. Concurrent writes to one worktree corrupt each other's index, history, and in-flight edits.
- **Check before you start.** Run `git worktree list` and `git branch` first; if there's any overlap with an existing agent's branch or worktree, pick a fresh, unique slug.
- `.claude/worktrees/` is git-ignored — never stage or commit it (it shows up as embedded gitlinks if you `git add -A` from the primary checkout; don't). Clean up per the rule above once merged or abandoned.

**Env vars:** copy `.env.example` → `.env`. `AGNIC_API_KEY` (single key for both the LLM gateway and x402 service payments) is required for any LLM call. See [.env.example](.env.example) for optional overrides.
never commit env vars.

### Database (locked — don't re-litigate)

Postgres conventions, settled in W0.1. Follow these; don't introduce another DB, ORM, or driver.

- **Host:** Neon (managed serverless Postgres). **No Docker / no local Postgres install** — local dev points at a Neon *dev branch*, prod uses the Neon *pooled* endpoint. Identical code path for both.
- **Driver/access:** `npm:postgres` (postgres.js), reached **only** through `getDb()` in [src/db/client.ts](src/db/client.ts). Never instantiate a client elsewhere. Swapping to the `@neondatabase/serverless` HTTP driver later stays local to that file.
- **Config:** a single `DATABASE_URL`. **Unset = no-op client** (queries resolve empty, no socket) so `deno task test` stays offline-safe. Gate any DB-dependent test on `dbEnabled()` / `DATABASE_URL` and `ignore` it when absent.
- **Schema:** plain portable Postgres in `db/migrations/*.sql` (no Neon/Supabase-specific features), applied by [scripts/migrate.ts](scripts/migrate.ts) via `deno task db:migrate` (forward-only, tracked in `schema_migrations`). Row types live in [src/db/types.ts](src/db/types.ts) — keep them column-for-column with the SQL.

#### Neon MCP key — scope & allowed operations (verified 2026-06-28)

`NEON_API_KEY` in `.env` is a **project-scoped** key bound to **project `super-grass-68246474`** (`ward-o-wallet-verifier`; default/primary branch `production` = `br-wispy-butterfly-aip28cgh`). The Neon MCP server (`mcp__neon__*`) is wired via [.mcp.json](.mcp.json) using this key. What it can and cannot do:

- **Always pass `projectId: super-grass-68246474` explicitly** (also in `.env` as `NEON_PROJECT_ID`). The MCP tool schemas come from Neon's hosted server (`mcp.neon.tech/mcp`, proxied via `mcp-remote` in [.mcp.json](.mcp.json)) — there is **no** client-side way to bake a default project into them, and the key cannot enumerate projects to discover its own ID. So the `projectId` argument is unavoidable; read it from `NEON_PROJECT_ID`.
- ✅ **Allowed — project-scoped reads/ops (with explicit `projectId`):** `describe_project`, `describe_branch`, `get_database_tables`, `describe_table_schema`, `run_sql` / `run_sql_transaction` (reads tested working), `explain_sql_statement`, `list_branch_computes`, `get_connection_string`. You can read all `public` + `neon_auth` tables.
- ❌ **Not allowed — org/account-level ops:** `list_projects`, `list_organizations`, `list_shared_projects`, `search`, and the REST equivalents (`/projects`, `/users/me`). These return `404 / "not allowed for organization API keys"`. Don't call them — they will always fail with this key.
- **Writes / migrations:** schema changes still go through `db/migrations/*.sql` + `deno task db:migrate` (see above), **not** MCP migration tools. Treat MCP as read/inspect access; never run destructive SQL (`DROP`/`DELETE`/`TRUNCATE`/`UPDATE` without `WHERE`) without explicit user approval.


## Surfaces

What this repo exposes — names + one-line role + entrypoint pointer.

**HTTP API** (mounted in [src/main.ts](src/main.ts)):

| Route | Purpose | Handler |
|-------|---------|---------|
| `GET /health` | Liveness | inline |
| `POST /discover` | Discovery-only (no payments); returns plan + cost estimate | [src/routes/discover.ts](src/routes/discover.ts) |
| `POST /discover-stream` | SSE variant of `/discover` | [src/routes/discover_stream.ts](src/routes/discover_stream.ts) |
| `POST /invoke` | Discovery + parallel paid invocation | [src/routes/invoke.ts](src/routes/invoke.ts) |
| `POST /verify-agent` | Pre-flight balance guard + invoke + LLM synthesis → final verdict | [src/routes/verify_agent.ts](src/routes/verify_agent.ts) |
| `POST /verify-agent-stream` | SSE variant of `/verify-agent` (phase/service/plan/verdict events) | [src/routes/verify_agent_stream.ts](src/routes/verify_agent_stream.ts) |
| `POST /mcp` | MCP Streamable HTTP (bearer-gated; see below) | [src/mcp/http.ts](src/mcp/http.ts) |

**MCP server** ([src/mcp/](src/mcp/)): one tool today (`verify_wallet`). Two transports share a single factory:
- stdio — [src/mcp/stdio.ts](src/mcp/stdio.ts), run via `deno task mcp:stdio` for local agent integrations.
- Streamable HTTP — [src/mcp/http.ts](src/mcp/http.ts), mounted at `/mcp`, gated by `MCP_SHARED_SECRET` bearer (returns `503 mcp_disabled` if unset).

**Module map (`src/`):**
- `agent/*` — verify pipeline orchestrator + LLM synthesis + chain primitives (Chainalysis oracle, ENS, eth-labels registry).
- `discovery/*` — x402 fanout, LLM rerank, durable health store, deterministic-sources builder.
- `routes/*` — Hono HTTP handlers (one file per route above).
- `mcp/*` — MCP transports + tool registration.
- `clients/agnic.ts` — Agnic gateway client (LLM + x402 proxy).
- `fixtures/wallets.ts` — canonical address→expected-verdict cases (regression anchor; sourced from `docs/real-wallet-tests`).

**Frontend (`web/`):** Vite + React single-page UI. Tasks: `npm run dev` (port 5173, Vite proxies API calls to backend on `:8000`), `npm run typecheck`, `npm run build`. Components in `web/src/components/`; SSE wiring in `web/src/api.ts`; flow-state hook in `web/src/hooks/useFlowState.ts`. Cloudflare Pages auto-deploys `main`.


Best Practices
Always handle partial responses - Streams can disconnect mid-response
Implement timeouts - Don't wait forever for chunks
Show loading state - Indicate when waiting for first chunk
Buffer for display - Some UI frameworks work better with small batches
Track usage - Final chunk may include token usage info

Use the following routes / rules to build out the application - key available in env vars for the project

1. to check balance:

```bash
curl https://api.agnic.ai/api/balance\?network\=base \
  -H "X-Agnic-Token: ${AGNIC_API_KEY}"
{"usdcBalance":"18.139474","address":"0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2","hasWallet":true,"network":"base","chainType":"ethereum","creditBalance":"49.9999","totalBalance":"68.139374"}% 
```

2. sample call to llm model with agnic interface
```bash
curl https://api.agnic.ai/v1/chat/completions \
  -H "X-Agnic-Token: ${AGNIC_API_KEY}" \    
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o-mini", <- same model choices as open-router
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

```

sample response
```bash
{"id":"gen-1779358422-LrEwL8SmYSWNlAzrHKq2","object":"chat.completion","created":1779358422,"model":"openai/gpt-4o-mini","provider":"Azure","system_fingerprint":"fp_eb37e061ec","choices":[{"index":0,"logprobs":null,"finish_reason":"stop","native_finish_reason":"stop","message":{"role":"assistant","content":"Hello! How can I assist you today?","refusal":null,"reasoning":null}}],"usage":{"prompt_tokens":9,"completion_tokens":10,"total_tokens":19,"cost":0.00000735,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.00000735,"upstream_inference_prompt_cost":0.00000135,"upstream_inference_completions_cost":0.000006},"completion_tokens_details":{"reasoning_tokens":0,"image_tokens":0,"audio_tokens":0}},"agnic":{"request_id":"req_6cJzSPFcRIwstAHJ","cost_usd":"0.000100","latency_ms":1219}}
```


## Agent memory

After completing any feature work, update the project memory:

1. **Append one row** to `docs/agent-log.md`:
   `| YYYY-MM-DD | <slug> | <one-line summary of what was built> |`

2. **Create `docs/features/<slug>.md`** with:
   - **What:** one sentence on what the feature does
   - **Files:** paths of files added or changed
   - **Config:** env vars or external dependencies added
   - **Notes:** gotchas, known gaps, or follow-ups

Use the slug from the log row as the filename. Do this at the end of every feature implementation, before closing out the task.

## Planning rules

When writing plan tickets (Plan persona), every ticket must include:

- **Acceptance criteria** — the observable behavior that proves the ticket is done
- **Validation commands** — exact `deno check`, `deno lint`, `deno test` commands to run
- **Test spec** — named test cases / scenarios that must exist (not just "write tests")
