import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { createVerifyAgentRouter, verifyAgentRouter } from "./verify_agent.ts";
import { WalletVerdictSchema } from "../agent/verdict.ts";
import type { AgnicBudget } from "../discovery/network.ts";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/verify-agent", verifyAgentRouter);
  return app;
}

// Builds an app whose router uses a stubbed budget fetcher. Lets us test the
// 503 path without hitting the real Agnic API.
function buildAppWithBudgetStub(
  budget: AgnicBudget | null | (() => Promise<never>),
): Hono {
  const app = new Hono();
  const router = createVerifyAgentRouter({
    budgetFetcher: typeof budget === "function"
      ? budget
      : () => Promise.resolve(budget),
  });
  app.route("/verify-agent", router);
  return app;
}

Deno.test("POST /verify-agent rejects malformed address with 400", async () => {
  const app = buildApp();
  const res = await app.request("/verify-agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: "not-an-address" }),
  });
  assertEquals(res.status, 400);
});

Deno.test("POST /verify-agent rejects non-EVM Solana-shaped address with 400", async () => {
  const app = buildApp();
  const res = await app.request("/verify-agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    }),
  });
  assertEquals(res.status, 400);
});

Deno.test("POST /verify-agent accepts a body with only `address` (no chain field)", async () => {
  // Body shape regression: chain used to be required. Now it's gone — the
  // route should parse cleanly. The request will likely fail downstream (no
  // AGNIC_API_KEY in test env) but it must NOT 400 on schema validation.
  const app = buildAppWithBudgetStub(null);
  Deno.env.set("AGNIC_BUDGET_MIN_USD", "10000");
  try {
    const res = await app.request("/verify-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
      }),
    });
    assertEquals(res.status !== 400, true);
  } finally {
    Deno.env.delete("AGNIC_BUDGET_MIN_USD");
  }
});

Deno.test("POST /verify-agent returns 503 when totalBalance is below the threshold", async () => {
  Deno.env.set("AGNIC_BUDGET_MIN_USD", "0.10");
  try {
    const app = buildAppWithBudgetStub({
      usdcBalance: 0.01,
      creditBalance: 0.02,
      totalBalance: 0.03,
    });
    const res = await app.request("/verify-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
      }),
    });
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.error, "budget_exhausted");
    assertEquals(body.totalBalance, 0.03);
    assertEquals(body.threshold, 0.10);
  } finally {
    Deno.env.delete("AGNIC_BUDGET_MIN_USD");
  }
});

Deno.test("POST /verify-agent skips the budget guard when the fetcher returns null", async () => {
  // null = "couldn't determine" (no API key or fetch failure). Must not 503.
  // We don't run the full verifyAgent in this hermetic test — the request will
  // fail past the guard for unrelated reasons (e.g. AGNIC_API_KEY missing).
  // The only thing we assert is: we are NOT 503 with budget_exhausted.
  Deno.env.set("AGNIC_BUDGET_MIN_USD", "10000");
  try {
    const app = buildAppWithBudgetStub(null);
    const res = await app.request("/verify-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
      }),
    });
    // Anything BUT a budget_exhausted 503 is acceptable here.
    if (res.status === 503) {
      const body = await res.json();
      assertEquals(body.error === "budget_exhausted", false);
    }
  } finally {
    Deno.env.delete("AGNIC_BUDGET_MIN_USD");
  }
});

Deno.test("POST /verify-agent does not block on budget-fetch failure", async () => {
  // A throwing fetcher should be swallowed and the request should proceed.
  Deno.env.set("AGNIC_BUDGET_MIN_USD", "10000");
  try {
    const app = buildAppWithBudgetStub(() => Promise.reject(new Error("network down")));
    const res = await app.request("/verify-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
      }),
    });
    if (res.status === 503) {
      const body = await res.json();
      assertEquals(body.error === "budget_exhausted", false);
    }
  } finally {
    Deno.env.delete("AGNIC_BUDGET_MIN_USD");
  }
});

// === END-TO-END test (hits real CDP + agnic + real x402 payments + real Opus). ===
// Run with: RUN_E2E=1 ~/.deno/bin/deno test --allow-net --allow-env src/routes/verify_agent_test.ts
// Costs ~$0.01–0.05 USDC per run (x402 spend + LLM call costs).
Deno.test({
  name: "POST /verify-agent end-to-end for funded mainnet wallet",
  ignore: !Deno.env.get("RUN_E2E"),
  fn: async () => {
    const app = buildApp();
    const res = await app.request("/verify-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
      }),
    });
    const body = await res.json();
    console.log("E2E /verify-agent response:", JSON.stringify(body, null, 2));

    assertEquals(res.status, 200);

    // Parse the verdict shape with zod — that's our schema contract.
    const verdict = WalletVerdictSchema.parse(body.verdict);
    assertEquals(typeof verdict.safe, "boolean");
    assertEquals(
      ["safe_to_transact", "do_not_transact", "insufficient_data"].includes(verdict.verdict),
      true,
    );
    assertEquals(verdict.coverage.resolved.length >= 1, true);
    assertEquals(
      typeof body.totalSpentUsdc === "number" && body.totalSpentUsdc < 0.05,
      true,
    );
    assertEquals(body.walletNetwork, "base");
  },
});
