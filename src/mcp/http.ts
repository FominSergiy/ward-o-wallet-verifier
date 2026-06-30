import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer, type McpAuthContext } from "./server.ts";
import { type VerdictCache } from "../agent/verdict_cache.ts";
import { type SanctionedDenylist } from "../agent/sanctioned_denylist.ts";
import { dbEnabled } from "../db/client.ts";
import { lookupApiKey, type ResolvedKey } from "../auth/api_keys.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Resolve the MCP authorization decision. Two ways to authorize:
 *   - the admin shared secret (MCP_SHARED_SECRET), or
 *   - a self-serve issued API key, validated against the DB (lookup).
 * The route is "disabled" only when NEITHER a shared secret nor a database is
 * configured — i.e. nothing could ever authorize a caller. Pure + injectable so
 * the decision is unit-testable without a transport or a live DB.
 */
export type McpAuth =
  | { kind: "disabled" }
  | { kind: "unauthorized" }
  | { kind: "ok"; apiKeyId: string | null; tenantId: string | null };

export async function authorizeMcp(opts: {
  bearer: string;
  secret: string | undefined;
  dbConfigured: boolean;
  lookup: (token: string) => Promise<ResolvedKey | null>;
}): Promise<McpAuth> {
  const { bearer, secret, dbConfigured, lookup } = opts;
  if (!secret && !dbConfigured) return { kind: "disabled" };
  if (!bearer) return { kind: "unauthorized" };
  // Admin shared secret → authorized, no per-key/tenant attribution.
  if (secret && bearer === secret) {
    return { kind: "ok", apiKeyId: null, tenantId: null };
  }
  // Otherwise it must be a valid issued key.
  const resolved = await lookup(bearer);
  if (resolved) {
    return { kind: "ok", apiKeyId: resolved.id, tenantId: resolved.tenantId };
  }
  return { kind: "unauthorized" };
}

export interface McpRouterOpts {
  // Injection seam for offline auth tests; real callers leave it undefined.
  lookupApiKey?: (token: string) => Promise<ResolvedKey | null>;
  // Injection seam for offline transport tests: build the per-session MCP
  // server with the given auth-context accessor (so a probe tool can capture
  // what attribution it sees). Real callers omit it → the production tools.
  buildServer?: (getAuthContext: () => McpAuthContext) => McpServer;
}

export function createMcpRouter(
  verdictCache?: VerdictCache,
  denylist?: SanctionedDenylist,
  opts: McpRouterOpts = {},
): Hono {
  const lookup = opts.lookupApiKey ?? lookupApiKey;

  // One transport per MCP session, each paired with a mutable auth `holder`.
  // The SDK manages the `Mcp-Session-Id` header and the in-memory SSE streams;
  // we map session id -> { transport, holder } so follow-up requests resume
  // against the right state. The streamable-HTTP transport returns its Response
  // before the tool body runs, so we cannot rely on an ALS scope around
  // handleRequest() reaching the tool. Instead each request stamps the latest
  // resolved attribution onto the session's holder, and the tool reads it (via
  // buildMcpServer's getAuthContext) when it actually executes. In-memory
  // per-isolate only — on multi-replica Deno Deploy a follow-up request may land
  // on a different isolate that doesn't know the session. Acceptable for now.
  interface Session {
    transport: WebStandardStreamableHTTPServerTransport;
    holder: { current: McpAuthContext };
  }
  const sessions = new Map<string, Session>();

  async function newSession(): Promise<Session> {
    const holder = { current: { apiKeyId: null, tenantId: null } } as {
      current: McpAuthContext;
    };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, holder });
      },
      onsessionclosed: (id: string) => {
        sessions.delete(id);
      },
    });
    const build = opts.buildServer ??
      ((getAuth: () => McpAuthContext) =>
        buildMcpServer(verdictCache, denylist, getAuth));
    await build(() => holder.current).connect(transport);
    return { transport, holder };
  }

  const router = new Hono();

  router.all("/*", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const bearer = auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length).trim()
      : "";

    const authz = await authorizeMcp({
      bearer,
      secret: Deno.env.get("MCP_SHARED_SECRET"),
      dbConfigured: dbEnabled(),
      lookup,
    });
    if (authz.kind === "disabled") {
      return c.json({ error: "mcp_disabled" }, 503);
    }
    if (authz.kind === "unauthorized") {
      return c.text("unauthorized", 401);
    }

    const sessionId = c.req.header("mcp-session-id") ?? undefined;
    const session = sessionId && sessions.has(sessionId)
      ? sessions.get(sessionId)!
      : await newSession();

    // Stamp this request's resolved attribution onto the session holder so the
    // tool body — which runs AFTER handleRequest() returns its Response — reads
    // the right key/tenant and re-establishes the ambient context for the
    // fire-and-forget observation + usage writers (see server.ts).
    session.holder.current = {
      apiKeyId: authz.apiKeyId,
      tenantId: authz.tenantId,
    };
    return await session.transport.handleRequest(c.req.raw);
  });

  return router;
}

/** Default export — no cache; main.ts uses createMcpRouter with the shared KV cache. */
export const mcpRouter = createMcpRouter();
