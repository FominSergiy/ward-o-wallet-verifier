import { assertEquals } from "@std/assert";
import { verifyAgent } from "./verify.ts";
import type { VerifyEvent } from "./events.ts";

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

function fakePlan() {
  return {
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
}

function fakeInvocation() {
  return {
    findings: { sanctions: { sanctions_match: false } },
    outcomes: [{
      category: "sanctions" as const,
      resource: "https://sanc.example",
      data: { sanctions_match: false },
      status: "ok" as const,
      amountUsdc: 0.001,
      durationMs: 5,
      paid: true,
      network: "base" as const,
      adapterPath: "pattern" as const,
    }],
    unresolved: [
      "labels",
      "onchain_history",
      "web_sentiment",
      "contract_analysis",
    ] as const,
    totalSpentUsdc: 0.001,
    walletNetwork: "base" as const,
  };
}

function fakeVerdict() {
  return {
    address: "0xABC0000000000000000000000000000000000123",
    chain: "base" as const,
    safe: true,
    verdict: "safe_to_transact" as const,
    confidence: "high" as const,
    headline: "all clear",
    reasoning: "ok",
    findings: [],
    coverage: { requested: [], resolved: [], unresolved: [] },
    totalSpentUsdc: 0.001,
    generatedAt: new Date().toISOString(),
  };
}

Deno.test("verifyAgent onEvent emits phase boundaries and plan event for happy path", async () => {
  const events: VerifyEvent[] = [];
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123", chain: "base" },
    {
      onEvent: (e) => events.push(e),
      _testHooks: {
        // Force the contract path so the EOA skip log doesn't appear in the
        // event stream — this test is asserting phase ordering, not EOA logic.
        isContract: () => Promise.resolve(true),
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: () => Promise.resolve(fakeVerdict()),
      },
    },
  );
  const summary = events.map((e) => {
    if (e.type === "phase") return `phase:${e.phase}:${e.status}`;
    return e.type;
  });
  // Expect: discover start → plan → discover end → invoke start → invoke end → synthesize start → synthesize end
  assertEquals(summary[0], "phase:discover:start");
  assertEquals(summary[1], "plan");
  assertEquals(summary[2], "phase:discover:end");
  assertEquals(summary[3], "phase:invoke:start");
  assertEquals(summary.at(-2), "phase:synthesize:start");
  assertEquals(summary.at(-1), "phase:synthesize:end");
  // Plan event payload sanity.
  const planEvent = events.find((e) => e.type === "plan");
  assertEquals(planEvent?.type, "plan");
  if (planEvent?.type === "plan") {
    assertEquals(planEvent.services.length, 1);
    assertEquals(planEvent.totalEstimatedCostUsdc, 0.001);
    assertEquals(planEvent.walletNetwork, "base");
  }
});

Deno.test("verifyAgent onEvent emits log:error then phase:synthesize:end on synthesis failure", async () => {
  const events: VerifyEvent[] = [];
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123", chain: "base" },
    {
      onEvent: (e) => events.push(e),
      _testHooks: {
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: () => Promise.reject(new Error("Opus 500")),
      },
    },
  );
  // Find the synthesize:start, log:error, synthesize:end sequence.
  const idxStart = events.findIndex(
    (e) => e.type === "phase" && e.phase === "synthesize" && e.status === "start",
  );
  const idxLog = events.findIndex(
    (e) => e.type === "log" && e.level === "error",
  );
  const idxEnd = events.findIndex(
    (e) => e.type === "phase" && e.phase === "synthesize" && e.status === "end",
  );
  assertEquals(idxStart >= 0, true);
  assertEquals(idxLog > idxStart, true);
  assertEquals(idxEnd > idxLog, true);
});

Deno.test("verifyAgent drops contract_analysis for EOA addresses (isContract=false)", async () => {
  let categoriesPassedToDiscover: string[] = [];
  let coveragePassedToSynthesize: unknown = null;
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123", chain: "base" },
    {
      _testHooks: {
        isContract: () => Promise.resolve(false),
        discover: (_addr, categories) => {
          categoriesPassedToDiscover = [...categories];
          return Promise.resolve(fakePlan());
        },
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: (input) => {
          coveragePassedToSynthesize = input.coverage;
          return Promise.resolve(fakeVerdict());
        },
      },
    },
  );
  // contract_analysis must be removed from the categories passed downstream.
  assertEquals(categoriesPassedToDiscover.includes("contract_analysis"), false);
  // not_applicable bucket carries the dropped category.
  const cov = coveragePassedToSynthesize as { not_applicable?: string[] };
  assertEquals(cov.not_applicable, ["contract_analysis"]);
});

Deno.test("verifyAgent keeps contract_analysis for contract addresses (isContract=true)", async () => {
  let categoriesPassedToDiscover: string[] = [];
  let coveragePassedToSynthesize: unknown = null;
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123", chain: "base" },
    {
      _testHooks: {
        isContract: () => Promise.resolve(true),
        discover: (_addr, categories) => {
          categoriesPassedToDiscover = [...categories];
          return Promise.resolve(fakePlan());
        },
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: (input) => {
          coveragePassedToSynthesize = input.coverage;
          return Promise.resolve(fakeVerdict());
        },
      },
    },
  );
  assertEquals(categoriesPassedToDiscover.includes("contract_analysis"), true);
  const cov = coveragePassedToSynthesize as { not_applicable?: string[] };
  assertEquals(cov.not_applicable, undefined);
});

Deno.test("verifyAgent onEvent thrown by consumer does not crash verifyAgent", async () => {
  let calls = 0;
  const r = await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123", chain: "base" },
    {
      onEvent: () => {
        calls++;
        throw new Error("consumer blew up");
      },
      _testHooks: {
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: () => Promise.resolve(fakeVerdict()),
      },
    },
  );
  // Pipeline finished despite every emit throwing.
  assertEquals(r.verdict.verdict, "safe_to_transact");
  assertEquals(calls > 0, true);
});
