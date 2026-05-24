import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "./server.ts";

// One transport per MCP session. The SDK manages the `Mcp-Session-Id` header
// and the in-memory SSE streams; we just map session id -> transport so
// follow-up requests resume against the right state. In-memory per-isolate
// only — on multi-replica Deno Deploy a follow-up request may land on a
// different isolate that doesn't know the session. Acceptable for the demo.
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

async function newSessionTransport(): Promise<
  WebStandardStreamableHTTPServerTransport
> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id: string) => {
      sessions.set(id, transport);
    },
    onsessionclosed: (id: string) => {
      sessions.delete(id);
    },
  });
  await buildMcpServer().connect(transport);
  return transport;
}

export const mcpRouter = new Hono();

mcpRouter.all("/*", async (c) => {
  const secret = Deno.env.get("MCP_SHARED_SECRET");
  if (!secret) {
    return c.json({ error: "mcp_disabled" }, 503);
  }
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return c.text("unauthorized", 401);
  }

  const sessionId = c.req.header("mcp-session-id") ?? undefined;
  const transport = sessionId && sessions.has(sessionId)
    ? sessions.get(sessionId)!
    : await newSessionTransport();

  return await transport.handleRequest(c.req.raw);
});
