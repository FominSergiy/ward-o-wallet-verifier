import { assertEquals } from "@std/assert";
import { verifyAgent } from "./verify.ts";
import { memoryCache } from "./verdict_cache.ts";
import { memoryDenylist } from "./sanctioned_denylist.ts";
import type { Chain } from "./types.ts";
import type { OracleResult } from "./sanctions_oracle.ts";
import type { EnsResolution } from "./ens_resolver.ts";
import type { WalletVerdict } from "./verdict.ts";

const ADDR = "0xABC0000000000000000000000000000000000123";

function oracleFn(isSanctioned: boolean): (
  address: string,
  chain: Chain,
) => Promise<OracleResult> {
  return (_address, chain) =>
    Promise.resolve({
      source: "chainalysis_oracle",
      oracleAddress: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
      chain,
      isSanctioned,
      checkedAt: new Date().toISOString(),
      rpcUrl: "https://test.rpc",
    });
}

function ensNullFn(): () => Promise<EnsResolution> {
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

function fakePlan() {
  return {
    address: ADDR,
    walletNetwork: "base" as const,
    services: [],
    alternates: {},
    totalEstimatedCostUsdc: 0,
    unresolvedCategories: [],
    deterministicSources: [],
    generatedAt: new Date().toISOString(),
  };
}

function fakeInvocation() {
  return {
    findings: { sanctions: { sanctions_match: false } },
    outcomes: [],
    unresolved: ["labels", "onchain_history", "web_sentiment"] as const,
    totalSpentUsdc: 0.023,
    walletNetwork: "base" as const,
  };
}

function makeVerdict(verdict: WalletVerdict["verdict"]): WalletVerdict {
  return {
    address: ADDR,
    chain: "eth",
    safe: verdict === "safe_to_transact",
    verdict,
    confidence: "high",
    headline: "test",
    reasoning: "test",
    findings: [],
    coverage: { requested: [], resolved: [], unresolved: [] },
    totalSpentUsdc: 0.023,
    generatedAt: new Date().toISOString(),
  };
}

Deno.test("fast tier: clean oracle → needs_deep_check, $0, no x402/synthesis", async () => {
  let invokeCalls = 0;
  let synthCalls = 0;

  const result = await verifyAgent({ address: ADDR }, {
    depth: "fast",
    _testHooks: {
      checkSanctionsOracle: oracleFn(false),
      resolveEns: ensNullFn(),
      selectFromRegistry: () => Promise.resolve(fakePlan()),
      // deno-lint-ignore no-explicit-any
      invokeAll: () => {
        invokeCalls++;
        return Promise.resolve(fakeInvocation() as any);
      },
      synthesizeVerdict: () => {
        synthCalls++;
        return Promise.resolve(makeVerdict("safe_to_transact"));
      },
    },
  });

  assertEquals(result.tier, "fast");
  assertEquals(result.fastSignal, "needs_deep_check");
  assertEquals(result.verdict.verdict, "insufficient_data");
  assertEquals(result.totalSpentUsdc, 0, "fast tier must never spend");
  assertEquals(invokeCalls, 0, "fast tier must not call x402");
  assertEquals(synthCalls, 0, "fast tier must not call synthesis");
});

Deno.test("fast tier: sanctioned oracle → block (do_not_transact), $0", async () => {
  const result = await verifyAgent({ address: ADDR }, {
    depth: "fast",
    _testHooks: {
      checkSanctionsOracle: oracleFn(true),
      resolveEns: ensNullFn(),
      selectFromRegistry: () => Promise.resolve(fakePlan()),
    },
  });

  assertEquals(result.fastSignal, "block");
  assertEquals(result.verdict.verdict, "do_not_transact");
  assertEquals(result.totalSpentUsdc, 0);
});

Deno.test("fast tier: cache-hit safe → proceed", async () => {
  const cache = memoryCache();
  cache.store.set(`eth:${ADDR.toLowerCase()}`, {
    verdict: makeVerdict("safe_to_transact"),
    outcomes: [],
    totalSpentUsdc: 0,
    totalLlmCostUsd: 0,
    walletNetwork: "base",
  });

  const result = await verifyAgent({ address: ADDR }, {
    depth: "fast",
    verdictCache: cache,
    _testHooks: {
      checkSanctionsOracle: oracleFn(false),
      resolveEns: ensNullFn(),
    },
  });

  assertEquals(result.fastSignal, "proceed");
  assertEquals(result.verdict.verdict, "safe_to_transact");
});

Deno.test("fast tier: denylist hit → block", async () => {
  const denylist = memoryDenylist();
  await denylist.set("eth", ADDR, {
    reason: "OFAC SDN",
    source: "ofac:0xB10C",
    warmedAt: new Date().toISOString(),
  });

  const result = await verifyAgent({ address: ADDR }, {
    depth: "fast",
    denylist,
    _testHooks: {
      checkSanctionsOracle: oracleFn(false),
      resolveEns: ensNullFn(),
    },
  });

  assertEquals(result.fastSignal, "block");
  assertEquals(result.verdict.verdict, "do_not_transact");
});

Deno.test("deep tier (default): runs full pipeline, tier=deep", async () => {
  let invokeCalls = 0;
  let synthCalls = 0;

  const result = await verifyAgent({ address: ADDR }, {
    // depth omitted → defaults to deep
    _testHooks: {
      checkSanctionsOracle: oracleFn(false),
      resolveEns: ensNullFn(),
      selectFromRegistry: () => Promise.resolve(fakePlan()),
      // deno-lint-ignore no-explicit-any
      invokeAll: () => {
        invokeCalls++;
        return Promise.resolve(fakeInvocation() as any);
      },
      synthesizeVerdict: () => {
        synthCalls++;
        return Promise.resolve(makeVerdict("safe_to_transact"));
      },
    },
  });

  assertEquals(result.tier, "deep");
  assertEquals(result.fastSignal, "proceed");
  assertEquals(result.verdict.verdict, "safe_to_transact");
  assertEquals(invokeCalls, 1, "deep tier must call x402");
  assertEquals(synthCalls, 1, "deep tier must call synthesis");
});
