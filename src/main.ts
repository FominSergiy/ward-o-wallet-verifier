import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyAgentRouter } from "./routes/verify_agent.ts";
import { verifyAgentStreamRouter } from "./routes/verify_agent_stream.ts";
import { discoverRouter } from "./routes/discover.ts";
import { discoverStreamRouter } from "./routes/discover_stream.ts";
import { invokeRouter } from "./routes/invoke.ts";
import { mcpRouter } from "./mcp/http.ts";

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

app.get("/health", (c) => c.json({ status: "ok" }));

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

const port = parseInt(Deno.env.get("PORT") ?? "8000");
console.log(`Starting on :${port}`);

Deno.serve({ port }, app.fetch);
