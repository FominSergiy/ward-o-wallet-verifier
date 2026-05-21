import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { discoverRouter } from "./discover.ts";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/discover", discoverRouter);
  return app;
}

Deno.test("POST /discover rejects malformed address with 400", async () => {
  const app = buildApp();
  const res = await app.request("/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: "not-an-address" }),
  });
  assertEquals(res.status, 400);
});

Deno.test("POST /discover rejects empty categories list with 400", async () => {
  const app = buildApp();
  const res = await app.request("/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
      categories: [],
    }),
  });
  assertEquals(res.status, 400);
});

// === END-TO-END test (hits real CDP discovery + real agnic balance). ===
// Run with: RUN_E2E=1 ~/.deno/bin/deno test --allow-net --allow-env src/routes/discover_test.ts
Deno.test({
  name: "POST /discover end-to-end against CDP and agnic",
  ignore: !Deno.env.get("RUN_E2E"),
  fn: async () => {
    const app = buildApp();
    const res = await app.request("/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
        categories: ["sanctions", "labels"],
      }),
    });
    const body = await res.json();
    console.log("E2E /discover response:", JSON.stringify(body, null, 2));

    assertEquals(res.status, 200);
    assertEquals(typeof body.address, "string");
    assertEquals(typeof body.walletNetwork, "string");
    assertEquals(Array.isArray(body.services), true);
    assertEquals(body.services.length >= 1, true, "expected ≥1 ranked service");
    assertEquals(typeof body.totalEstimatedCostUsdc, "number");
    assertEquals(body.totalEstimatedCostUsdc > 0, true);
    for (const s of body.services) {
      assertEquals(s.resource.startsWith("https://"), true);
      assertEquals(typeof s.priceUsdc, "number");
      assertEquals(typeof s.rationale, "string");
    }
  },
});

Deno.test({
  name: "POST /discover with no categories override defaults to all non-ens",
  ignore: !Deno.env.get("RUN_E2E"),
  fn: async () => {
    const app = buildApp();
    const res = await app.request("/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
      }),
    });
    const body = await res.json();
    assertEquals(res.status, 200);
    // Either resolved or unresolved — every non-ens category must appear in one bucket.
    const resolved = new Set((body.services as { category: string }[]).map((s) => s.category));
    const unresolved = new Set(body.unresolvedCategories as string[]);
    const expected = ["sanctions", "labels", "onchain_history", "web_sentiment", "contract_analysis"];
    for (const c of expected) {
      assertEquals(
        resolved.has(c) || unresolved.has(c),
        true,
        `category ${c} missing from both resolved and unresolved`,
      );
    }
  },
});
