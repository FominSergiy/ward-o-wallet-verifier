import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "./server.ts";
import { type VerdictCache } from "../agent/verdict_cache.ts";
import { type SanctionedDenylist } from "../agent/sanctioned_denylist.ts";
import { dbEnabled } from "../db/client.ts";
import { lookupApiKey, type ResolvedKey } from "../auth/api_keys.ts";
import { runWithApiKey } from "../observability/request_context.ts";

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
  | { kind: "ok"; apiKeyId: string | null };

export async function authorizeMcp(opts: {
  bearer: string;
  secret: string | undefined;
  dbConfigured: boolean;
  lookup: (token: string) => Promise<ResolvedKey | null>;
}): Promise<McpAuth> {
  const { bearer, secret, dbConfigured, lookup } = opts;
  if (!secret && !dbConfigured) return { kind: "disabled" };
  if (!bearer) return { kind: "unauthorized" };
  // Admin shared secret → authorized, no per-key attribution.
  if (secret && bearer === secret) return { kind: "ok", apiKeyId: null };
  // Otherwise it must be a valid issued key.
  const resolved = await lookup(bearer);
  if (resolved) return { kind: "ok", apiKeyId: resolved.id };
  return { kind: "unauthorized" };
}

export interface McpRouterOpts {
  // Injection seam for offline auth tests; real callers leave it undefined.
  lookupApiKey?: (token: string) => Promise<ResolvedKey | null>;
}

export function createMcpRouter(
  verdictCache?: VerdictCache,
  denylist?: SanctionedDenylist,
  opts: McpRouterOpts = {},
): Hono {
  const lookup = opts.lookupApiKey ?? lookupApiKey;

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
    await buildMcpServer(verdictCache, denylist).connect(transport);
    return transport;
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
    const transport = sessionId && sessions.has(sessionId)
      ? sessions.get(sessionId)!
      : await newSessionTransport();

    // Carry the key id through the verify pipeline so service_observations rows
    // are attributed to it (see observability/request_context.ts).
    return await runWithApiKey(
      authz.apiKeyId,
      () => transport.handleRequest(c.req.raw),
    );
  });

  return router;
}

/** Default export — no cache; main.ts uses createMcpRouter with the shared KV cache. */
export const mcpRouter = createMcpRouter();
