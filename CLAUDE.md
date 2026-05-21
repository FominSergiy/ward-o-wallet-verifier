# Agent instructions

## GitHub

Use `mcp__github__*` MCP tools for all GitHub operations — PRs, issues, comments, reading files.
Never use the `gh` CLI.

The MCP server is pre-configured in `.mcp.json` (token via `$AGNIC_GH_TOKEN`).
Repo owner: `FominSergiy`, repo name: `agnic-agent-wallet-verifier`.

## Project tools

**Runtime:** Deno. Binary: `~/.deno/bin/deno`. All tasks are in `deno.json`.

| Task | Command |
|------|---------|
| Dev server (watch) | `deno task dev` |
| Run tests | `deno task test` |
| Lint | `deno task lint` |
| Type-check | `deno task check` |

When working in a worktree or targeting specific files, use the binary directly:

```bash
~/.deno/bin/deno check <file>.ts <file>_test.ts
~/.deno/bin/deno lint <file>.ts <file>_test.ts
~/.deno/bin/deno test --allow-net --allow-env <file>_test.ts
```

**Env vars:** copy `.env.example` → `.env`. `OPENROUTER_API_KEY` is required for any LLM call.

## Planning rules

When writing plan tickets (Plan persona), every ticket must include:

- **Acceptance criteria** — the observable behavior that proves the ticket is done
- **Validation commands** — exact `deno check`, `deno lint`, `deno test` commands to run
- **Test spec** — named test cases / scenarios that must exist (not just "write tests")
