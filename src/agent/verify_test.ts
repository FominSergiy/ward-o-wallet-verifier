import { assertEquals } from "@std/assert";
import { verifyAgent } from "./verify.ts";

Deno.test("verifyAgent returns stub verdict + receipts when synthesis throws", async () => {
  const fakePlan = {
    address: "0xABC0000000000000000000000000000000000123",
    walletNetwork: "base" as const,
    services: [{
      category: "sanctions" as const,
      resource: "https://sanc.example",
      description: "x",
      priceUsdc: 0.001,
      network: "eip155:8453",
      payTo: "0xp",
      scheme: "exact" as const,
      qualityScore: null,
      rationale: "r",
    }],
    alternates: {},
    totalEstimatedCostUsdc: 0.001,
    unresolvedCategories: [],
    generatedAt: new Date().toISOString(),
  };
  const fakeOutcome = {
    category: "sanctions" as const,
    resource: "https://sanc.example",
    data: { sanctions_match: false },
    status: "ok" as const,
    amountUsdc: 0.001,
    durationMs: 5,
    paid: true,
    network: "base" as const,
    adapterPath: "pattern" as const,
  };
  const r = await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123", chain: "base" },
    {
      _testHooks: {
        discover: () => Promise.resolve(fakePlan),
        invokeAll: () =>
          Promise.resolve({
            findings: { sanctions: { sanctions_match: false } },
            outcomes: [fakeOutcome],
            unresolved: ["labels", "onchain_history", "web_sentiment", "contract_analysis"],
            totalSpentUsdc: 0.001,
            walletNetwork: "base" as const,
          }),
        synthesizeVerdict: () => Promise.reject(new Error("Opus 500: internal_error")),
      },
    },
  );
  assertEquals(r.synthesisError?.includes("Opus 500"), true);
  assertEquals(r.verdict.verdict, "insufficient_data");
  assertEquals(r.verdict.safe, false);
  assertEquals(r.verdict.confidence, "low");
  assertEquals(r.verdict.headline.includes("Synthesis failed"), true);
  // Receipts must survive the synthesis failure.
  assertEquals(r.outcomes.length, 1);
  assertEquals(r.outcomes[0].status, "ok");
  assertEquals(r.totalSpentUsdc, 0.001);
});
