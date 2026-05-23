# mcp-server

## What

Wraps the existing `verifyAgent()` pipeline as a Model Context Protocol (MCP) server, exposing a single `verify_wallet` tool over both stdio (for agents that spawn the server locally) and WebStandard Streamable HTTP (for hosted/remote use). Lets any MCP-capable agent (Claude Desktop, Claude Code, Cursor, etc.) call wallet risk verification without integrating against the HTTP API.

## Files

- **New:**
  - [src/mcp/server.ts](../../src/mcp/server.ts) — transport-agnostic factory `buildMcpServer()`; registers `verify_wallet` with zod-validated input shape reusing `ChainSchema` / `CategorySchema` from `src/agent/types.ts`.
  - [src/mcp/stdio.ts](../../src/mcp/stdio.ts) — stdio entrypoint (`StdioServerTransport`).
  - [src/mcp/http.ts](../../src/mcp/http.ts) — `WebStandardStreamableHTTPServerTransport` mounted on `Deno.serve`, port `MCP_HTTP_PORT` (default `9765`). Per-session transport map keyed by `mcp-session-id`.
  - [scripts/mcp_e2e.ts](../../scripts/mcp_e2e.ts) — spawns the stdio server, calls `tools/list`, then invokes `verify_wallet` (vitalik.eth, eth, $0.05 cap). 5-minute SDK request timeout.
- **Modified:**
  - [deno.json](../../deno.json) — added `@modelcontextprotocol/sdk` (npm) to imports; new tasks `mcp:stdio`, `mcp:http`.

## Config

- **New dependency:** `npm:@modelcontextprotocol/sdk@^1.29.0`
- **New env var:** `MCP_HTTP_PORT` (optional, default `9765`)
- **Existing env vars:** `AGNIC_API_KEY` (required for the underlying paid x402 calls)

## Notes

- Used `WebStandardStreamableHTTPServerTransport`, not the Node-flavored `StreamableHTTPServerTransport`. It takes a Web Standard `Request` and returns a `Response` — drops straight into `Deno.serve` with zero shimming.
- Default MCP SDK `callTool` timeout is 60s; a full verification needs ~45–90s. The E2E script passes `{ timeout: 300_000 }`. Agents that call `verify_wallet` must do the same.
- The tool returns both `content[0].text` (JSON-stringified verdict for clients that ignore structured content) and `structuredContent` (typed `WalletVerdict` for clients that prefer it).
- No auth on the HTTP transport — out of scope for the proof. For hosted production, add OAuth 2.1 per the MCP spec or a static API-key header (`X-Agnic-Token` would be the natural fit).
- The HTTP server stores sessions in-memory. Multi-replica hosting needs a session store (Redis) or a stateless deploy with `sessionIdGenerator: undefined`.

## Verification

Run from this worktree (`.claude/worktrees/feat-mcp-server`):

```bash
# Type check + lint
~/.deno/bin/deno check src/mcp/server.ts src/mcp/stdio.ts src/mcp/http.ts scripts/mcp_e2e.ts
~/.deno/bin/deno lint src/mcp/ scripts/mcp_e2e.ts

# E2E (real wallet, costs ~$0.02 USDC, needs AGNIC_API_KEY)
~/.deno/bin/deno run -A --env-file=.env scripts/mcp_e2e.ts

# HTTP smoke test
MCP_HTTP_PORT=9765 ~/.deno/bin/deno task mcp:http &
curl -s -X POST http://localhost:9765/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
kill %1
```

## E2E result snapshot (2026-05-23)

- Tool listed: `verify_wallet` with full JSON schema
- Wallet: `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (vitalik.eth) on `eth`
- Verdict: `safe_to_transact` (confidence: medium)
- Resolved categories: sanctions, labels, onchain_history, web_sentiment
- Not applicable: contract_analysis (EOA short-circuit)
- Total spent: **$0.0174 USDC** (cap: $0.05)
- Elapsed: 44.9 s
- HTTP transport: `initialize` returned `mcp-session-id` header + `serverInfo` = `agnic-wallet-verifier 0.1.0`
