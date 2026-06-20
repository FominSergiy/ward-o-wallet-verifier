import { assertEquals } from "@std/assert";
import { memoryCache } from "./verdict_cache.ts";
import type { WalletVerdict } from "./verdict.ts";
import { verifyAgent } from "./verify.ts";
import type { Chain } from "./types.ts";
import type { OracleResult } from "./sanctions_oracle.ts";
import type { EnsResolution } from "./ens_resolver.ts";

function makeVerdict(
  verdict: WalletVerdict["verdict"],
  address = "0xABC0000000000000000000000000000000000123",
): WalletVerdict {
  return {
    address,
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

// --- memoryCache unit tests ---

Deno.test("memoryCache: get returns null when empty", async () => {
  const c = memoryCache();
  assertEquals(await c.get("eth", "0xABC"), null);
});

Deno.test("memoryCache: set then get returns cached verdict", async () => {
  const c = memoryCache();
  const v = makeVerdict("safe_to_transact");
  await c.set("eth", v.address, v);
  const hit = await c.get("eth", v.address);
  assertEquals(hit?.verdict, "safe_to_transact");
});

Deno.test("memoryCache: address lookup is case-insensitive", async () => {
  const c = memoryCache();
  const v = makeVerdict(
    "safe_to_transact",
    "0xABC000000000000000000000000000000000CAFE",
  );
  await c.set("eth", v.address, v);
  const hit = await c.get("eth", v.address.toLowerCase());
  assertEquals(hit?.verdict, "safe_to_transact");
});

Deno.test("memoryCache: do_not_transact is cached", async () => {
  const c = memoryCache();
  const v = makeVerdict("do_not_transact");
  await c.set("eth", v.address, v);
  assertEquals((await c.get("eth", v.address))?.verdict, "do_not_transact");
});

Deno.test("memoryCache: insufficient_data is never cached", async () => {
  const c = memoryCache();
  const v = makeVerdict("insufficient_data");
  await c.set("eth", v.address, v);
  assertEquals(await c.get("eth", v.address), null);
});

Deno.test("memoryCache: different chains are independent keys", async () => {
  const c = memoryCache();
  const addr = "0xABC0000000000000000000000000000000000123";
  const vEth = makeVerdict("safe_to_transact", addr);
  const vBase = {
    ...makeVerdict("do_not_transact", addr),
    chain: "base" as Chain,
  };
  await c.set("eth", addr, vEth);
  await c.set("base", addr, vBase);
  assertEquals((await c.get("eth", addr))?.verdict, "safe_to_transact");
  assertEquals((await c.get("base", addr))?.verdict, "do_not_transact");
});

// --- verifyAgent integration tests ---

function cleanOracleFn(): (
  address: string,
  chain: Chain,
) => Promise<OracleResult> {
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
    deterministicSources: [],
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
    unresolved: ["labels", "onchain_history", "web_sentiment"] as const,
    totalSpentUsdc: 0.001,
    walletNetwork: "base" as const,
  };
}

const ADDR = "0xABC0000000000000000000000000000000000123";

Deno.test("verdict_cache: second call returns cached verdict without service calls", async () => {
  const cache = memoryCache();
  let invokeCalls = 0;
  let synthesizeCalls = 0;

  const opts = {
    verdictCache: cache,
    _testHooks: {
      checkSanctionsOracle: cleanOracleFn(),
      resolveEns: ensNullFn(),
      selectFromRegistry: () => Promise.resolve(fakePlan()),
      // deno-lint-ignore no-explicit-any
      invokeAll: () => {
        invokeCalls++;
        return Promise.resolve(fakeInvocation() as any);
      },
      synthesizeVerdict: () => {
        synthesizeCalls++;
        return Promise.resolve(makeVerdict("safe_to_transact", ADDR));
      },
    },
  };

  // First call — populates cache.
  const r1 = await verifyAgent({ address: ADDR }, opts);
  assertEquals(r1.verdict.verdict, "safe_to_transact");
  assertEquals(invokeCalls, 1);
  assertEquals(synthesizeCalls, 1);

  // Second call — cache hit, no service calls.
  const r2 = await verifyAgent({ address: ADDR }, opts);
  assertEquals(r2.verdict.verdict, "safe_to_transact");
  assertEquals(invokeCalls, 1, "invokeAll must not be called on cache hit");
  assertEquals(
    synthesizeCalls,
    1,
    "synthesizeVerdict must not be called on cache hit",
  );
});

Deno.test("verdict_cache: do_not_transact TTL is distinct from safe_to_transact (both cached)", async () => {
  const cache = memoryCache();

  // Prime with do_not_transact.
  const dnt = makeVerdict("do_not_transact", ADDR);
  await cache.set("eth", ADDR, dnt);

  let synthesizeCalls = 0;
  const opts = {
    verdictCache: cache,
    _testHooks: {
      checkSanctionsOracle: cleanOracleFn(),
      resolveEns: ensNullFn(),
      selectFromRegistry: () => Promise.resolve(fakePlan()),
      // deno-lint-ignore no-explicit-any
      invokeAll: () => Promise.resolve(fakeInvocation() as any),
      synthesizeVerdict: () => {
        synthesizeCalls++;
        return Promise.resolve(makeVerdict("safe_to_transact", ADDR));
      },
    },
  };

  const r = await verifyAgent({ address: ADDR }, opts);
  assertEquals(r.verdict.verdict, "do_not_transact");
  assertEquals(synthesizeCalls, 0, "cache hit must skip synthesis");
});

Deno.test("verdict_cache: insufficient_data is not cached, next call runs full pipeline", async () => {
  const cache = memoryCache();
  let synthesizeCalls = 0;

  const opts = {
    verdictCache: cache,
    _testHooks: {
      checkSanctionsOracle: cleanOracleFn(),
      resolveEns: ensNullFn(),
      selectFromRegistry: () => Promise.resolve(fakePlan()),
      // deno-lint-ignore no-explicit-any
      invokeAll: () => Promise.resolve(fakeInvocation() as any),
      synthesizeVerdict: () => {
        synthesizeCalls++;
        return Promise.resolve(makeVerdict("insufficient_data", ADDR));
      },
    },
  };

  await verifyAgent({ address: ADDR }, opts);
  await verifyAgent({ address: ADDR }, opts);

  // Both calls should have hit synthesis — no caching for insufficient_data.
  assertEquals(synthesizeCalls, 2);
});
