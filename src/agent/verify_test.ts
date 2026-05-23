import { assertEquals } from "@std/assert";
import { verifyAgent } from "./verify.ts";
import type { VerifyEvent } from "./events.ts";
import type { Chain } from "./types.ts";
import type { OracleResult } from "./sanctions_oracle.ts";
import type { EnsResolution } from "./ens_resolver.ts";
import type { RegistryResult } from "./labels_registry.ts";

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

// Returns a clean oracle result for whichever chain is queried. Used to stub
// the multi-chain oracle fan-out — each of the 5 chains queried gets a clean
// response.
function cleanOracleFn(): (address: string, chain: Chain) => Promise<OracleResult> {
  return (_address, chain) =>
    Promise.resolve({
      source: "chainalysis_oracle",
      oracleAddress: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
      chain,
      isSanctioned: false,
      checkedAt: new Date().toISOString(),
      rpcUrl: "https://test.rpc",
    });
}

// Returns isSanctioned=true ONLY for the specified chain — other chains
// return clean. Lets us assert the strictest-wins behavior of the fan-out.
function oracleSanctionedOn(
  flagged: Chain,
): (address: string, chain: Chain) => Promise<OracleResult> {
  return (_address, chain) =>
    Promise.resolve({
      source: "chainalysis_oracle",
      oracleAddress: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
      chain,
      isSanctioned: chain === flagged,
      checkedAt: new Date().toISOString(),
      rpcUrl: "https://test.rpc",
    });
}

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
    chain: "eth" as const,
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

Deno.test("verifyAgent returns stub verdict + receipts when synthesis throws", async () => {
  const r = await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracleFn(),
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: () => Promise.reject(new Error("Opus 500: internal_error")),
      },
    },
  );
  assertEquals(r.synthesisError?.includes("Opus 500"), true);
  assertEquals(r.verdict.verdict, "insufficient_data");
  assertEquals(r.verdict.safe, false);
  assertEquals(r.verdict.confidence, "low");
  assertEquals(r.verdict.headline.includes("Synthesis failed"), true);
  assertEquals(r.outcomes.length, 1);
  assertEquals(r.outcomes[0].status, "ok");
  assertEquals(r.totalSpentUsdc, 0.001);
});

Deno.test("verifyAgent onEvent emits phase boundaries and plan event for happy path", async () => {
  const events: VerifyEvent[] = [];
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123" },
    {
      onEvent: (e) => events.push(e),
      _testHooks: {
        checkSanctionsOracle: cleanOracleFn(),
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
  // Filter out log + service events (oracle/ENS fan-out emits both) so we
  // only assert on the structural phase + plan sequence.
  const summary = events
    .filter((e) => e.type !== "log" && e.type !== "service")
    .map((e) => {
      if (e.type === "phase") return `phase:${e.phase}:${e.status}`;
      return e.type;
    });
  assertEquals(summary[0], "phase:discover:start");
  assertEquals(summary[1], "plan");
  assertEquals(summary[2], "phase:discover:end");
  assertEquals(summary[3], "phase:invoke:start");
  assertEquals(summary.at(-2), "phase:synthesize:start");
  assertEquals(summary.at(-1), "phase:synthesize:end");
  const planEvent = events.find((e) => e.type === "plan");
  assertEquals(planEvent?.type, "plan");
  if (planEvent?.type === "plan") {
    assertEquals(planEvent.services.length, 1);
    assertEquals(planEvent.totalEstimatedCostUsdc, 0.001);
    assertEquals(planEvent.walletNetwork, "base");
  }
});

Deno.test("verifyAgent fans out oracle: emits one service event per supported chain", async () => {
  const events: VerifyEvent[] = [];
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123" },
    {
      onEvent: (e) => events.push(e),
      _testHooks: {
        checkSanctionsOracle: cleanOracleFn(),
        isContract: () => Promise.resolve(true),
        resolveEns: ensNull(),
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: () => Promise.resolve(fakeVerdict()),
      },
    },
  );
  const oracleStartEvents = events.filter(
    (e) =>
      e.type === "service" &&
      e.status === "start" &&
      e.resource.startsWith("chainalysis_oracle://"),
  );
  // One start event per supported chain (eth, base, polygon, arbitrum, optimism).
  assertEquals(oracleStartEvents.length, 5);
  for (const ev of oracleStartEvents) {
    if (ev.type === "service") {
      assertEquals(ev.kind, "direct");
      assertEquals(ev.category, "sanctions");
    }
  }
});

Deno.test("verifyAgent onEvent emits log:error then phase:synthesize:end on synthesis failure", async () => {
  const events: VerifyEvent[] = [];
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123" },
    {
      onEvent: (e) => events.push(e),
      _testHooks: {
        checkSanctionsOracle: cleanOracleFn(),
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: () => Promise.reject(new Error("Opus 500")),
      },
    },
  );
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
    { address: "0xABC0000000000000000000000000000000000123" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracleFn(),
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
  assertEquals(categoriesPassedToDiscover.includes("contract_analysis"), false);
  // Default chain is eth → ENS is natively supported, so only
  // contract_analysis ends up in not_applicable for an EOA.
  const cov = coveragePassedToSynthesize as { not_applicable?: string[] };
  assertEquals(cov.not_applicable?.includes("contract_analysis"), true);
  assertEquals(cov.not_applicable?.includes("ens"), false);
});

Deno.test("verifyAgent keeps contract_analysis for contract addresses (isContract=true)", async () => {
  let categoriesPassedToDiscover: string[] = [];
  let coveragePassedToSynthesize: unknown = null;
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracleFn(),
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
  // Default chain is eth — nothing should land in not_applicable when both
  // ENS and contract_analysis are supported and the address is a contract.
  assertEquals(cov.not_applicable, undefined);
});

Deno.test("verifyAgent short-circuits when oracle flags address on any chain (eth-only hit)", async () => {
  let discoverCalled = false;
  let invokeCalled = false;
  let synthesizeCalled = false;
  const r = await verifyAgent(
    { address: "0x7F367cC41522cE07553e823bf3be79A889DEbe1B" },
    {
      _testHooks: {
        // The reported-bug scenario: this address is flagged ONLY on eth's
        // oracle deployment. Old single-chain code (chain="base") would have
        // missed it. The new fan-out must still catch it.
        checkSanctionsOracle: oracleSanctionedOn("eth"),
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
  assertEquals(discoverCalled, false);
  assertEquals(invokeCalled, false);
  assertEquals(synthesizeCalled, false);
  assertEquals(r.verdict.verdict, "do_not_transact");
  assertEquals(r.verdict.confidence, "high");
  assertEquals(r.verdict.safe, false);
  assertEquals(r.totalSpentUsdc, 0);
  assertEquals(r.outcomes.length, 0);
  assertEquals(r.verdict.findings.length, 1);
  assertEquals(r.verdict.findings[0].category, "sanctions");
  assertEquals(r.verdict.findings[0].severity, "critical");
  // Verdict's chain field reports which chain's oracle did the flagging.
  assertEquals(r.verdict.chain, "eth");
});

Deno.test("verifyAgent merges oracle-clean result into findings.sanctions for synthesis", async () => {
  let synthesisInput: unknown = null;
  await verifyAgent(
    { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracleFn(),
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

Deno.test("verifyAgent proceeds normally when every oracle chain throws", async () => {
  let discoverCalled = false;
  const r = await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123" },
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
  assertEquals(discoverCalled, true);
  assertEquals(r.verdict.verdict, "safe_to_transact");
});

Deno.test("verifyAgent calls ENS resolver and merges result into findings", async () => {
  let synthesisInput: unknown = null;
  const events: VerifyEvent[] = [];
  await verifyAgent(
    { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    {
      onEvent: (e) => events.push(e),
      _testHooks: {
        checkSanctionsOracle: cleanOracleFn(),
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
  // The ENS resolver now emits service events so the flow diagram can render
  // it as a direct chain-primitive path.
  const ensServiceStart = events.find(
    (e) =>
      e.type === "service" &&
      e.status === "start" &&
      e.resource.startsWith("ens://"),
  );
  assertEquals(ensServiceStart !== undefined, true);
  if (ensServiceStart?.type === "service") {
    assertEquals(ensServiceStart.kind, "direct");
    assertEquals(ensServiceStart.category, "ens");
  }
});

Deno.test("verifyAgent treats ENS resolver failure as silent (no verdict impact)", async () => {
  let synthesisInput: unknown = null;
  await verifyAgent(
    { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracleFn(),
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
  assertEquals(findings.ens, undefined);
});

function registryHit(
  labels: RegistryResult["labels"],
): () => Promise<RegistryResult> {
  return () =>
    Promise.resolve({
      source: "eth_labels_registry",
      endpoint: "https://eth-labels.com/labels/0xtest",
      address: "0xtest",
      chain: "eth",
      labels,
      checkedAt: new Date().toISOString(),
    });
}

Deno.test("registry_merges_into_findings_labels_when_x402_succeeds", async () => {
  let synthesisInput: unknown = null;
  await verifyAgent(
    { address: "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3", chain: "eth" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracle(),
        resolveEns: ensNull(),
        isContract: () => Promise.resolve(false),
        fetchLabelsRegistry: registryHit([
          {
            address: "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
            chainId: 1,
            label: "coinbase",
            nameTag: "Coinbase 1",
          },
        ]),
        discover: () => Promise.resolve(fakePlan()),
        invokeAll: () =>
          Promise.resolve({
            findings: { labels: { some_x402_payload: true } },
            outcomes: [],
            unresolved: [],
            totalSpentUsdc: 0,
            walletNetwork: "base" as const,
          }),
        synthesizeVerdict: (input) => {
          synthesisInput = input;
          return Promise.resolve(fakeVerdict());
        },
      },
    },
  );
  const labels =
    (synthesisInput as { findings: { labels: Record<string, unknown> } })
      .findings.labels;
  // Merged shape: both keys present.
  assertEquals("x402_result" in labels, true);
  assertEquals("registry" in labels, true);
  const reg = labels.registry as RegistryResult;
  assertEquals(reg.labels[0].label, "coinbase");
});

Deno.test("registry_rescues_labels_when_x402_fails", async () => {
  let synthesisInput: unknown = null;
  await verifyAgent(
    { address: "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3", chain: "eth" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracle(),
        resolveEns: ensNull(),
        isContract: () => Promise.resolve(false),
        fetchLabelsRegistry: registryHit([
          {
            address: "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
            chainId: 1,
            label: "coinbase",
            nameTag: "Coinbase 1",
          },
        ]),
        discover: () => Promise.resolve(fakePlan()),
        invokeAll: () =>
          Promise.resolve({
            findings: {},
            outcomes: [],
            unresolved: ["labels"],
            totalSpentUsdc: 0,
            walletNetwork: "base" as const,
          }),
        synthesizeVerdict: (input) => {
          synthesisInput = input;
          return Promise.resolve(fakeVerdict());
        },
      },
    },
  );
  const findings =
    (synthesisInput as { findings: { labels?: Record<string, unknown> } })
      .findings;
  // findings.labels exists with only the registry key — no x402_result wrapper.
  assertEquals(findings.labels !== undefined, true);
  assertEquals("registry" in (findings.labels ?? {}), true);
  assertEquals("x402_result" in (findings.labels ?? {}), false);
  // Coverage should no longer mark labels as unresolved.
  const cov =
    (synthesisInput as { coverage: { unresolved: string[]; resolved: string[] } })
      .coverage;
  assertEquals(cov.unresolved.includes("labels"), false);
  assertEquals(cov.resolved.includes("labels"), true);
});

Deno.test("registry_failure_is_swallowed_and_does_not_block_verdict", async () => {
  let synthesisInput: unknown = null;
  const r = await verifyAgent(
    { address: "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3", chain: "eth" },
    {
      _testHooks: {
        checkSanctionsOracle: cleanOracle(),
        resolveEns: ensNull(),
        isContract: () => Promise.resolve(false),
        fetchLabelsRegistry: () =>
          Promise.reject(new Error("eth-labels DNS failure")),
        discover: () => Promise.resolve(fakePlan()),
        invokeAll: () =>
          Promise.resolve({
            findings: { labels: { some_x402_payload: true } },
            outcomes: [],
            unresolved: [],
            totalSpentUsdc: 0,
            walletNetwork: "base" as const,
          }),
        synthesizeVerdict: (input) => {
          synthesisInput = input;
          return Promise.resolve(fakeVerdict());
        },
      },
    },
  );
  assertEquals(r.verdict.verdict, "safe_to_transact");
  const labels =
    (synthesisInput as { findings: { labels: Record<string, unknown> } })
      .findings.labels;
  // Original x402 payload survives untouched — no wrapper.
  assertEquals(labels, { some_x402_payload: true });
});

Deno.test("registry_skipped_when_labels_category_not_requested", async () => {
  let registryCalled = false;
  await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123", chain: "base" },
    {
      categories: ["sanctions"],
      _testHooks: {
        checkSanctionsOracle: cleanOracle(),
        isContract: () => Promise.resolve(false),
        fetchLabelsRegistry: () => {
          registryCalled = true;
          return Promise.resolve({
            source: "eth_labels_registry",
            endpoint: "x",
            address: "x",
            chain: "base",
            labels: [],
            checkedAt: new Date().toISOString(),
          });
        },
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: () => Promise.resolve(fakeVerdict()),
      },
    },
  );
  assertEquals(registryCalled, false);
});

Deno.test("verifyAgent onEvent thrown by consumer does not crash verifyAgent", async () => {
  let calls = 0;
  const r = await verifyAgent(
    { address: "0xABC0000000000000000000000000000000000123" },
    {
      onEvent: () => {
        calls++;
        throw new Error("consumer blew up");
      },
      _testHooks: {
        checkSanctionsOracle: cleanOracleFn(),
        discover: () => Promise.resolve(fakePlan()),
        // deno-lint-ignore no-explicit-any
        invokeAll: () => Promise.resolve(fakeInvocation() as any),
        synthesizeVerdict: () => Promise.resolve(fakeVerdict()),
      },
    },
  );
  assertEquals(r.verdict.verdict, "safe_to_transact");
  assertEquals(calls > 0, true);
});
