import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { invokeRouter } from "./invoke.ts";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/invoke", invokeRouter);
  return app;
}

Deno.test("POST /invoke rejects malformed address with 400", async () => {
  const app = buildApp();
  const res = await app.request("/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: "not-an-address", chain: "base" }),
  });
  assertEquals(res.status, 400);
});

Deno.test("POST /invoke rejects empty categories list with 400", async () => {
  const app = buildApp();
  const res = await app.request("/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
      chain: "base",
      categories: [],
    }),
  });
  assertEquals(res.status, 400);
});

Deno.test("POST /invoke rejects missing chain with 400", async () => {
  const app = buildApp();
  const res = await app.request("/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
    }),
  });
  assertEquals(res.status, 400);
});

// === END-TO-END test (hits real CDP + agnic + real x402 payments). ===
// Run with: RUN_E2E=1 ~/.deno/bin/deno test --allow-net --allow-env src/routes/invoke_test.ts
// Costs ~$0.005–0.02 USDC per run.
Deno.test({
  name: "POST /invoke end-to-end against CDP + agnic",
  ignore: !Deno.env.get("RUN_E2E"),
  fn: async () => {
    const app = buildApp();
    const res = await app.request("/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
        chain: "base",
        categories: ["sanctions", "labels"],
      }),
    });
    const body = await res.json();
    console.log("E2E /invoke response:", JSON.stringify(body, null, 2));

    assertEquals(res.status, 200);
    assertEquals(typeof body.findings, "object");
    assertEquals(Array.isArray(body.receipts), true);
    assertEquals(body.receipts.length >= 1, true);
    assertEquals(typeof body.totalSpentUsdc, "number");
    // At least one category resolved
    const resolvedCount = Object.keys(body.findings).length;
    assertEquals(resolvedCount >= 1, true);
  },
});

Deno.test({
  name: "POST /invoke with full default category set returns multiple findings",
  ignore: !Deno.env.get("RUN_E2E"),
  fn: async () => {
    const app = buildApp();
    const res = await app.request("/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
        chain: "base",
      }),
    });
    const body = await res.json();
    assertEquals(res.status, 200);
    // At minimum sanctions must resolve or the route would 502.
    assertEquals("sanctions" in body.findings, true);
    // Budget sanity check.
    assertEquals(body.totalSpentUsdc < 0.05, true);
  },
});
