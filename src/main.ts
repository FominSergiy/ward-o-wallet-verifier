import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyAgentRouter } from "./routes/verify_agent.ts";
import { discoverRouter } from "./routes/discover.ts";
import { invokeRouter } from "./routes/invoke.ts";

const app = new Hono();

app.use(
  "/*",
  cors({
    origin: Deno.env.get("ALLOWED_ORIGIN") ?? "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/verify-agent", verifyAgentRouter);
app.route("/discover", discoverRouter);
app.route("/invoke", invokeRouter);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

const port = parseInt(Deno.env.get("PORT") ?? "8000");
console.log(`Starting on :${port}`);

Deno.serve({ port }, app.fetch);
