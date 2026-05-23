import { assertEquals } from "@std/assert";
import { verifyAgent } from "./verify.ts";
import type { VerifyEvent } from "./events.ts";
import type { OracleResult } from "./sanctions_oracle.ts";
import type { EnsResolution } from "./ens_resolver.ts";

function ensNull(): () => Promise<EnsResolution> {
  return () =>
    Promise.resolve({
      source: "viem_ens",
      chain: "eth",
      address: "0x",
      ensName: null,
      rpcUrl: "https://test.rpc",
      checkedAt: new Date().toISOString(),
    });
}

function ensHit(name: string): () => Promise<EnsResolution> {
  return () =>
    Promise.resolve({
      source: "viem_ens",
      chain: "eth",
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      ensName: name,
      rpcUrl: "https://test.rpc",
      checkedAt: new Date().toISOString(),
    });
}

function cleanOracle(): () => Promise<OracleResult> {
  return () =>
    Promise.resolve({
      source: "chainalysis_oracle",
      oracleAddress: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
      chain: "base",
      isSanctioned: false,
      checkedAt: new Date().toISOString(),
      rpcUrl: "https://test.rpc",
    });
}

function sanctionedOracle(): () => Promise<OracleResult> {
  return () =>
    Promise.resolve({
      source: "chainalysis_oracle",
      oracleAddress: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
      chain: "base",
      isSanctioned: true,
      checkedAt: new Date().toISOString(),
      rpcUrl: "https://test.rpc",
    });
}

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
        checkSanctionsOracle: cleanOracle(),
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
        checkSanctionsOracle: cleanOracle(),
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
  // Filter out log events (the oracle check emits one before discover) so we
  // only assert on the structural phase + plan sequence.
  const summary = events
    .filter((e) => e.type !== "log")
    .map((e) => {
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
        checkSanctionsOracle: cleanOracle(),
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
        checkSanctionsOracle: cleanOracle(),
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
  // not_applicable bucket carries the dropped category. On base, "ens" is
  // also not applicable (no native ENS reverse), so both should be present.
  const cov = coveragePassedToSynthesize as { not_applicable?: string[] };
  assertEquals(cov.not_applicable?.includes("contract_analysis"), true);
  assertEquals(cov.not_applicable?.includes("ens"), true);
});

Deno.test("verifyAgent keeps contract_analysis for contract addresses (isContract=true)", async () => {
  let categoriesPassedToDiscover: string[] = [];
  let coveragePassedToSynthesize: unknown = null;
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123", chain: "base" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracle(),
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
  // On base, ENS is not natively supported → ens is the only not_applicable.
  assertEquals(cov.not_applicable, ["ens"]);
});

Deno.test("verifyAgent short-circuits on sanctioned oracle hit (no x402, no synthesis)", async () => {
  let discoverCalled = false;
  let invokeCalled = false;
  let synthesizeCalled = false;
  const r = await verifyAgent(
    { address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96", chain: "eth" },
    {
      _testHooks: {
        checkSanctionsOracle: sanctionedOracle(),
        isContract: () => Promise.resolve(false),
        discover: () => {
          discoverCalled = true;
          return Promise.resolve(fakePlan());
        },
        // deno-lint-ignore no-explicit-any
        invokeAll: () => {
          invokeCalled = true;
          return Promise.resolve(fakeInvocation() as any);
        },
        synthesizeVerdict: () => {
          synthesizeCalled = true;
          return Promise.resolve(fakeVerdict());
        },
      },
    },
  );
  // None of the downstream phases should have run.
  assertEquals(discoverCalled, false);
  assertEquals(invokeCalled, false);
  assertEquals(synthesizeCalled, false);
  // Deterministic verdict.
  assertEquals(r.verdict.verdict, "do_not_transact");
  assertEquals(r.verdict.confidence, "high");
  assertEquals(r.verdict.safe, false);
  assertEquals(r.totalSpentUsdc, 0);
  assertEquals(r.outcomes.length, 0);
  // Sanctions finding is present.
  assertEquals(r.verdict.findings.length, 1);
  assertEquals(r.verdict.findings[0].category, "sanctions");
  assertEquals(r.verdict.findings[0].severity, "critical");
});

Deno.test("verifyAgent merges oracle-clean result into findings.sanctions for synthesis", async () => {
  let synthesisInput: unknown = null;
  await verifyAgent(
    { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chain: "eth" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracle(),
        resolveEns: ensNull(),
        isContract: () => Promise.resolve(false),
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: (input) => {
          synthesisInput = input;
          return Promise.resolve(fakeVerdict());
        },
      },
    },
  );
  const sanctions = (synthesisInput as { findings: { sanctions: unknown } })
    .findings.sanctions as { chainalysis_oracle?: { isSanctioned: boolean } };
  assertEquals(sanctions.chainalysis_oracle?.isSanctioned, false);
});

Deno.test("verifyAgent proceeds normally when oracle check throws", async () => {
  let discoverCalled = false;
  const r = await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123", chain: "eth" },
    {
      _testHooks: {
        checkSanctionsOracle: () =>
          Promise.reject(new Error("RPC timeout — oracle unavailable")),
        resolveEns: ensNull(),
        isContract: () => Promise.resolve(false),
        discover: () => {
          discoverCalled = true;
          return Promise.resolve(fakePlan());
        },
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: () => Promise.resolve(fakeVerdict()),
      },
    },
  );
  // Normal flow runs.
  assertEquals(discoverCalled, true);
  assertEquals(r.verdict.verdict, "safe_to_transact");
});

Deno.test("verifyAgent calls ENS resolver and merges result into findings for eth chain", async () => {
  let synthesisInput: unknown = null;
  await verifyAgent(
    { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chain: "eth" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracle(),
        resolveEns: ensHit("vitalik.eth"),
        isContract: () => Promise.resolve(false),
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: (input) => {
          synthesisInput = input;
          return Promise.resolve(fakeVerdict());
        },
      },
    },
  );
  const ens = (synthesisInput as { findings: { ens: { ensName?: string } } })
    .findings.ens;
  assertEquals(ens.ensName, "vitalik.eth");
  const cov = (synthesisInput as { coverage: { resolved: string[] } }).coverage;
  assertEquals(cov.resolved.includes("ens"), true);
});

Deno.test("verifyAgent skips ENS resolver on non-eth chain and adds ens to not_applicable", async () => {
  let ensCalled = false;
  let synthesisInput: unknown = null;
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123", chain: "base" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracle(),
        resolveEns: () => {
          ensCalled = true;
          return Promise.resolve({
            source: "viem_ens",
            chain: "base",
            address: "0x",
            ensName: null,
            rpcUrl: "x",
            checkedAt: new Date().toISOString(),
          });
        },
        isContract: () => Promise.resolve(false),
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: (input) => {
          synthesisInput = input;
          return Promise.resolve(fakeVerdict());
        },
      },
    },
  );
  assertEquals(ensCalled, false);
  const cov = (synthesisInput as { coverage: { not_applicable?: string[] } })
    .coverage;
  assertEquals(cov.not_applicable?.includes("ens"), true);
});

Deno.test("verifyAgent treats ENS resolver failure as silent (no verdict impact)", async () => {
  let synthesisInput: unknown = null;
  await verifyAgent(
    { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chain: "eth" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracle(),
        resolveEns: () => Promise.reject(new Error("ENS RPC blew up")),
        isContract: () => Promise.resolve(false),
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: (input) => {
          synthesisInput = input;
          return Promise.resolve(fakeVerdict());
        },
      },
    },
  );
  const findings = (synthesisInput as { findings: { ens?: unknown } }).findings;
  // ENS finding is absent when the resolver throws — not corrupted, not stubbed.
  assertEquals(findings.ens, undefined);
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
        checkSanctionsOracle: cleanOracle(),
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
