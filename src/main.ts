import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyAgentRouter } from "./routes/verify_agent.ts";
import { verifyAgentStreamRouter } from "./routes/verify_agent_stream.ts";
import { discoverRouter } from "./routes/discover.ts";
import { discoverStreamRouter } from "./routes/discover_stream.ts";
import { invokeRouter } from "./routes/invoke.ts";
import { mcpRouter } from "./mcp/http.ts";
import { dbEnabled, getDb } from "./db/client.ts";

const app = new Hono();

/**
 * DB connectivity for /health. "disabled" when DATABASE_URL is unset (the
 * no-op client — expected offline/in tests); "ok" when a SELECT 1 round-trips;
 * "error" when a real DATABASE_URL is set but unreachable. Lets a deploy verify
 * the Postgres wiring with a single curl instead of waiting for a route to need it.
 */
async function dbHealth(): Promise<"ok" | "disabled" | "error"> {
  if (!dbEnabled()) return "disabled";
  try {
    await getDb()`SELECT 1`;
    return "ok";
  } catch {
    return "error";
  }
}

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

app.get("/health", async (c) => c.json({ status: "ok", db: await dbHealth() }));

app.route("/verify-agent", verifyAgentRouter);
app.route("/verify-agent-stream", verifyAgentStreamRouter);
app.route("/discover", discoverRouter);
app.route("/discover-stream", discoverStreamRouter);
app.route("/invoke", invokeRouter);
app.route("/mcp", mcpRouter);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export { app };

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") ?? "8000");
  console.log(`Starting on :${port}`);
  Deno.serve({ port }, app.fetch);
}
