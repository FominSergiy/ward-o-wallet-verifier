import { Hono } from "hono";
import { cors } from "hono/cors";
import { createVerifyAgentRouter } from "./routes/verify_agent.ts";
import { createVerifyAgentStreamRouter } from "./routes/verify_agent_stream.ts";
import { discoverRouter } from "./routes/discover.ts";
import { discoverStreamRouter } from "./routes/discover_stream.ts";
import { invokeRouter } from "./routes/invoke.ts";
import { createMcpRouter } from "./mcp/http.ts";
import { dbEnabled, getDb } from "./db/client.ts";
import { denoKvCache, type VerdictCache } from "./agent/verdict_cache.ts";

async function dbHealth(): Promise<"ok" | "disabled" | "error"> {
  if (!dbEnabled()) return "disabled";
  try {
    await getDb()`SELECT 1`;
    return "ok";
  } catch {
    return "error";
  }
}

export function createApp(verdictCache?: VerdictCache): Hono {
  const app = new Hono();

  app.use(
    "/*",
    cors({
      origin: Deno.env.get("ALLOWED_ORIGIN") ?? "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "Mcp-Session-Id",
        "Mcp-Protocol-Version",
      ],
    }),
  );

  app.get(
    "/health",
    async (c) => c.json({ status: "ok", db: await dbHealth() }),
  );

  app.route("/verify-agent", createVerifyAgentRouter({ verdictCache }));
  app.route(
    "/verify-agent-stream",
    createVerifyAgentStreamRouter({ verdictCache }),
  );
  app.route("/discover", discoverRouter);
  app.route("/discover-stream", discoverStreamRouter);
  app.route("/invoke", invokeRouter);
  app.route("/mcp", createMcpRouter(verdictCache));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  return app;
}

// No-cache instance for module imports (tests). Production entry point below
// opens KV and passes a real cache.
export const app = createApp();

if (import.meta.main) {
  const kv = await Deno.openKv();
  const cache = denoKvCache(kv);
  const port = parseInt(Deno.env.get("PORT") ?? "8000");
  console.log(`Starting on :${port}`);
  Deno.serve({ port }, createApp(cache).fetch);
}
