import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "./server.ts";

// One transport per MCP session. The SDK manages the `Mcp-Session-Id` header
// and the in-memory SSE streams; we just map session id -> transport so
// follow-up requests resume against the right state.
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

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }

  if (url.pathname !== "/mcp") {
    return new Response("Not found", { status: 404 });
  }

  const sessionId = req.headers.get("mcp-session-id") ?? undefined;
  const transport = sessionId
    ? sessions.get(sessionId) ?? (await newSessionTransport())
    : await newSessionTransport();

  return await transport.handleRequest(req);
}

const port = parseInt(Deno.env.get("MCP_HTTP_PORT") ?? "9765");
console.log(`MCP HTTP transport on :${port}/mcp`);
Deno.serve({ port }, handle);
