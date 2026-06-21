import { assertEquals, assertExists } from "@std/assert";
import { memoryDenylist } from "./sanctioned_denylist.ts";
import { verifyAgent } from "./verify.ts";
import type { Chain } from "./types.ts";
import type { OracleResult } from "./sanctions_oracle.ts";
import type { EnsResolution } from "./ens_resolver.ts";
import type { WalletVerdict } from "./verdict.ts";

const ADDR = "0xD90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b";

// --- memoryDenylist unit tests ---

Deno.test("memoryDenylist: has returns null when empty", async () => {
  const d = memoryDenylist();
  assertEquals(await d.has("eth", ADDR), null);
});

Deno.test("memoryDenylist: set then has returns entry, case-insensitive", async () => {
  const d = memoryDenylist();
  await d.set("eth", ADDR, {
    reason: "OFAC SDN",
    source: "ofac:0xB10C",
    warmedAt: new Date().toISOString(),
  });
  const hit = await d.has("eth", ADDR.toLowerCase());
  assertEquals(hit?.reason, "OFAC SDN");
  assertEquals(hit?.source, "ofac:0xB10C");
});

Deno.test("memoryDenylist: different chains are independent keys", async () => {
  const d = memoryDenylist();
  await d.set("eth", ADDR, {
    reason: "OFAC SDN",
    source: "x",
    warmedAt: "t",
  });
  assertEquals(await d.has("base", ADDR), null);
  assertExists(await d.has("eth", ADDR));
});

// --- verifyAgent integration tests ---

function spyOracle(counter: { calls: number }): (
  address: string,
  chain: Chain,
) => Promise<OracleResult> {
  return (_address, chain) => {
    counter.calls++;
    return Promise.resolve({
      source: "chainalysis_oracle",
      oracleAddress: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
      chain,
      isSanctioned: false,
      checkedAt: new Date().toISOString(),
      rpcUrl: "https://test.rpc",
    });
  };
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
    totalSpentUsdc: 0,
    generatedAt: new Date().toISOString(),
  };
}

Deno.test("denylist hit: returns do_not_transact WITHOUT oracle or x402 calls, $0", async () => {
  const denylist = memoryDenylist();
  await denylist.set("eth", ADDR, {
    reason: "OFAC SDN",
    source: "ofac:0xB10C",
    warmedAt: new Date().toISOString(),
  });

  const oracleCounter = { calls: 0 };
  let invokeCalls = 0;
  let synthCalls = 0;

  const result = await verifyAgent({ address: ADDR }, {
    denylist,
    _testHooks: {
      checkSanctionsOracle: spyOracle(oracleCounter),
      resolveEns: ensNullFn(),
      selectFromRegistry: () => Promise.resolve(fakePlan()),
      // deno-lint-ignore no-explicit-any
      invokeAll: () => {
        invokeCalls++;
        return Promise.resolve({} as any);
      },
      synthesizeVerdict: () => {
        synthCalls++;
        return Promise.resolve(makeVerdict("safe_to_transact"));
      },
    },
  });

  assertEquals(result.verdict.verdict, "do_not_transact");
  assertEquals(result.fastSignal, "block");
  assertEquals(result.totalSpentUsdc, 0);
  assertEquals(
    oracleCounter.calls,
    0,
    "oracle must not be called on denylist hit",
  );
  assertEquals(
    invokeCalls,
    0,
    "x402 invokeAll must not be called on denylist hit",
  );
  assertEquals(synthCalls, 0, "synthesis must not be called on denylist hit");
});

Deno.test("denylist miss: falls through to the live oracle path", async () => {
  const denylist = memoryDenylist(); // empty
  const oracleCounter = { calls: 0 };

  const result = await verifyAgent({ address: ADDR }, {
    denylist,
    depth: "fast", // stop before x402 to keep the test offline
    _testHooks: {
      checkSanctionsOracle: spyOracle(oracleCounter),
      resolveEns: ensNullFn(),
      selectFromRegistry: () => Promise.resolve(fakePlan()),
    },
  });

  // Empty denylist → oracle ran (one call per supported chain).
  assertEquals(
    oracleCounter.calls > 0,
    true,
    "oracle must run on denylist miss",
  );
  // Clean oracle in fast mode → needs_deep_check, not a block.
  assertEquals(result.fastSignal, "needs_deep_check");
});
