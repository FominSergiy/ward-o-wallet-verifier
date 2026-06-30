import { assertEquals, assertRejects } from "@std/assert";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorizeMcp, createMcpRouter } from "./http.ts";
import type { McpAuthContext } from "./server.ts";
import type { ResolvedKey } from "../auth/api_keys.ts";
import {
  currentApiKeyId,
  currentTenantId,
  runWithRequestContext,
} from "../observability/request_context.ts";

const noLookup = (_t: string): Promise<ResolvedKey | null> =>
  Promise.resolve(null);

Deno.test("authorizeMcp: disabled when neither secret nor db is configured", async () => {
  const a = await authorizeMcp({
    bearer: "x",
    secret: undefined,
    dbConfigured: false,
    lookup: noLookup,
  });
  assertEquals(a.kind, "disabled");
});

Deno.test("authorizeMcp: admin shared secret authorizes with null apiKeyId/tenantId", async () => {
  const a = await authorizeMcp({
    bearer: "s3cret",
    secret: "s3cret",
    dbConfigured: false,
    lookup: noLookup,
  });
  assertEquals(a, { kind: "ok", apiKeyId: null, tenantId: null });
});

Deno.test("authorizeMcp: a valid issued key authorizes with its id + tenant", async () => {
  const lookup = (t: string): Promise<ResolvedKey | null> =>
    Promise.resolve(
      t === "wardo_sk_good" ? { id: "key-1", tenantId: "tenant-1" } : null,
    );
  const a = await authorizeMcp({
    bearer: "wardo_sk_good",
    secret: undefined,
    dbConfigured: true,
    lookup,
  });
  assertEquals(a, { kind: "ok", apiKeyId: "key-1", tenantId: "tenant-1" });
});

Deno.test("authorizeMcp: an unknown bearer is unauthorized", async () => {
  const a = await authorizeMcp({
    bearer: "wardo_sk_bad",
    secret: undefined,
    dbConfigured: true,
    lookup: noLookup,
  });
  assertEquals(a.kind, "unauthorized");
});

Deno.test("authorizeMcp: empty bearer (while enabled) is unauthorized", async () => {
  const a = await authorizeMcp({
    bearer: "",
    secret: "s",
    dbConfigured: false,
    lookup: noLookup,
  });
  assertEquals(a.kind, "unauthorized");
});

// --- Transport-level attribution (the bug fix) ------------------------------
//
// These drive a real MCP Streamable-HTTP round-trip (client SDK → Hono app →
// WebStandard transport → tool body) and capture what the tool observes in
// ambient context. The regression: the tool body runs AFTER the transport's
// Response is returned, so an ALS scope wrapped around handleRequest() leaked
// `null` into the writers. The fix binds attribution onto a per-session holder
// the tool reads at execution time.

const TEST_SECRET = "test-admin-secret";

// A probe MCP server whose single tool re-establishes the request context from
// the injected accessor (mirroring the real verify tools) and records what the
// fire-and-forget writers would see.
function makeProbeServer(
  captured: McpAuthContext[],
): (getAuth: () => McpAuthContext) => McpServer {
  return (getAuth) => {
    const server = new McpServer({ name: "probe", version: "0" });
    server.registerTool("probe", { inputSchema: {} }, () => {
      const { apiKeyId, tenantId } = getAuth();
      return runWithRequestContext(apiKeyId, tenantId, () => {
        captured.push({
          apiKeyId: currentApiKeyId(),
          tenantId: currentTenantId(),
        });
        return { content: [{ type: "text" as const, text: "ok" }] };
      });
    });
    return server;
  };
}

async function callProbe(opts: {
  bearer?: string;
  lookup: (token: string) => Promise<ResolvedKey | null>;
  captured: McpAuthContext[];
}): Promise<void> {
  const app = new Hono();
  app.route(
    "/mcp",
    createMcpRouter(undefined, undefined, {
      lookupApiKey: opts.lookup,
      buildServer: makeProbeServer(opts.captured),
    }),
  );

  const client = new Client({ name: "probe-client", version: "0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost/mcp"),
    {
      // Route the SDK's fetch through the in-process Hono app — no real socket.
      fetch: (url: string | URL, init?: RequestInit) =>
        app.request(url instanceof URL ? url.toString() : url, init),
      requestInit: opts.bearer
        ? { headers: { Authorization: `Bearer ${opts.bearer}` } }
        : undefined,
    },
  );

  try {
    await client.connect(transport);
    await client.callTool({ name: "probe", arguments: {} });
  } finally {
    await client.close().catch(() => {});
  }
}

// Enable the router via the shared secret so a stubbed lookup can resolve issued
// keys without a configured DATABASE_URL. Restores the prior env afterward.
async function withSecret(fn: () => Promise<void>): Promise<void> {
  const prev = Deno.env.get("MCP_SHARED_SECRET");
  Deno.env.set("MCP_SHARED_SECRET", TEST_SECRET);
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("MCP_SHARED_SECRET");
    else Deno.env.set("MCP_SHARED_SECRET", prev);
  }
}

Deno.test("MCP tool handler observes the resolved apiKeyId/tenantId across the streaming boundary", async () => {
  await withSecret(async () => {
    const captured: McpAuthContext[] = [];
    const lookup = (t: string): Promise<ResolvedKey | null> =>
      Promise.resolve(
        t === "wardo_sk_good" ? { id: "key-1", tenantId: "tenant-1" } : null,
      );
    await callProbe({ bearer: "wardo_sk_good", lookup, captured });
    assertEquals(captured, [{ apiKeyId: "key-1", tenantId: "tenant-1" }]);
  });
});

Deno.test("MCP admin shared-secret bearer reaches the tool with null apiKeyId/tenantId", async () => {
  await withSecret(async () => {
    const captured: McpAuthContext[] = [];
    await callProbe({ bearer: TEST_SECRET, lookup: noLookup, captured });
    assertEquals(captured, [{ apiKeyId: null, tenantId: null }]);
  });
});

Deno.test("MCP invalid bearer is rejected and never runs the tool", async () => {
  await withSecret(async () => {
    const captured: McpAuthContext[] = [];
    await assertRejects(() =>
      callProbe({ bearer: "wardo_sk_bad", lookup: noLookup, captured })
    );
    assertEquals(captured, []);
  });
});
