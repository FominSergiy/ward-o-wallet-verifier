# deploy-mcp-pipeline

## What

Restores the MCP server (deleted on `feat/deploy-pipeline` because the branch was cut before MCP landed) and folds its HTTP transport into the main Hono app, so a single Deno Deploy push ships REST + `/mcp` together. Adds bearer-token auth (`MCP_SHARED_SECRET`) so the public endpoint can't burn `AGNIC_API_KEY` for arbitrary callers.

## Files

- **Added (restored from `main`):**
  - [src/mcp/server.ts](../../src/mcp/server.ts) — `buildMcpServer()` factory; `verify_wallet` tool. Verbatim from `main`.
  - [src/mcp/stdio.ts](../../src/mcp/stdio.ts) — stdio entrypoint for local agent spawn. Verbatim from `main`.
  - [scripts/mcp_e2e.ts](../../scripts/mcp_e2e.ts) — stdio E2E (vitalik.eth, eth, $0.05 cap). Verbatim from `main`.
  - [docs/features/mcp-server.md](mcp-server.md) — restored with new Deployment subsection.

- **Rewritten:**
  - [src/mcp/http.ts](../../src/mcp/http.ts) — replaces the standalone `Deno.serve` on port 9765 with a Hono router (`export const mcpRouter`) mounted at `/mcp` on the main app. Includes bearer-auth middleware.

- **Modified:**
  - [src/main.ts](../../src/main.ts) — import `mcpRouter`; `app.route("/mcp", mcpRouter)`; CORS `allowHeaders` extended with `Mcp-Session-Id`, `Mcp-Protocol-Version`.
  - [deno.json](../../deno.json) — re-added `@modelcontextprotocol/sdk` import; new `mcp:stdio` task; `check` task now covers `src/mcp/stdio.ts` in addition to `src/main.ts`. The old `mcp:http` task is intentionally **not** re-added (HTTP now ships via `start`).
  - [docs/deployment.md](../deployment.md) — added `MCP_SHARED_SECRET` to env-var table; replaced the "Future: MCP HTTP endpoint" placeholder with a real `## 4. MCP endpoint` runbook section (smoke test + Claude Desktop / Code config); noted that rotating the secret invalidates live sessions.

## Config

- **New env var (required to expose `/mcp`):** `MCP_SHARED_SECRET` — clients must send `Authorization: Bearer <value>`. Generate with `openssl rand -hex 32`. If unset, `/mcp` returns `503 { "error": "mcp_disabled" }` (loud failure on misconfig).
- **Dependency:** `npm:@modelcontextprotocol/sdk@^1.29.0` re-added.
- **CI:** no workflow change — existing `deno lint` and `deno task check` cover the new files (check task expanded to include `src/mcp/stdio.ts`; the HTTP router is reached transitively from `src/main.ts`).

## Notes

- Decision: single deployment, not two. The standalone `Deno.serve(..., handle)` from `main`'s `src/mcp/http.ts` was rewritten as a Hono router rather than kept as a parallel process. Rationale: one Deno Deploy project, reuse CORS / error handler / env vars, matches the topology already documented in `deployment.md`.
- `WebStandardStreamableHTTPServerTransport.handleRequest()` takes a Web Standard `Request`; Hono exposes it via `c.req.raw`. No shimming needed.
- Sessions are per-isolate (in-memory `Map`). On a multi-replica Deno Deploy this can route follow-up requests to a fresh isolate that doesn't know the session — acceptable for the hackathon demo; Redis is the production fix.
- The bearer secret is the only thing gating `/mcp`. Anyone with it can call `verify_wallet`, which spends `AGNIC_API_KEY` (~$0.01–0.05/call). Treat as a sensitive credential.
- The `mcp:stdio` task is preserved for local Claude Desktop / Code integrations that spawn the verifier on the user's machine; it doesn't affect the deploy pipeline.

## Verification

```bash
# In .claude/worktrees/mcp-deploy
~/.deno/bin/deno check src/main.ts src/mcp/stdio.ts
~/.deno/bin/deno lint
~/.deno/bin/deno task test

# Smoke /mcp end-to-end
MCP_SHARED_SECRET=$(openssl rand -hex 32) ~/.deno/bin/deno task start &
sleep 2
curl -s http://localhost:8000/health                                         # → {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
# → 401
curl -i -X POST http://localhost:8000/mcp \
  -H "Authorization: Bearer $MCP_SHARED_SECRET" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
# → 200 + Mcp-Session-Id response header
kill %1
```
