import { assertEquals } from "@std/assert";
import { type CachedVerdict, memoryCache } from "./verdict_cache.ts";
import type { WalletVerdict } from "./verdict.ts";
import type { ServiceInvocationOutcome } from "./invoke_service.ts";
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

// Wraps a verdict into the full cache envelope (receipts + cost totals) the
// cache now stores so a hit can re-render the paid-services breakdown.
function makeEntry(
  verdict: WalletVerdict["verdict"],
  address = "0xABC0000000000000000000000000000000000123",
  overrides: Partial<CachedVerdict> = {},
): CachedVerdict {
  const outcome: ServiceInvocationOutcome = {
    category: "sanctions",
    resource: "https://sanc.example",
    data: { sanctions_match: false },
    status: "ok",
    amountUsdc: 0.001,
    durationMs: 5,
    paid: true,
    network: "base",
    adapterPath: "pattern",
  };
  return {
    verdict: makeVerdict(verdict, address),
    outcomes: [outcome],
    totalSpentUsdc: 0.001,
    totalLlmCostUsd: 0.002,
    walletNetwork: "base",
    ...overrides,
  };
}

// --- memoryCache unit tests ---

Deno.test("memoryCache: get returns null when empty", async () => {
  const c = memoryCache();
  assertEquals(await c.get("eth", "0xABC"), null);
});

Deno.test("memoryCache: set then get returns cached verdict", async () => {
  const c = memoryCache();
  const e = makeEntry("safe_to_transact");
  await c.set("eth", e.verdict.address, e);
  const hit = await c.get("eth", e.verdict.address);
  assertEquals(hit?.verdict.verdict, "safe_to_transact");
});

Deno.test("memoryCache: round-trips the full envelope (receipts + costs)", async () => {
  const c = memoryCache();
  const e = makeEntry("safe_to_transact");
  await c.set("eth", e.verdict.address, e);
  const hit = await c.get("eth", e.verdict.address);
  // The per-service receipts and the cost totals must survive the round-trip
  // so a cache hit can render the same breakdown a fresh deep run would.
  assertEquals(hit?.outcomes.length, 1);
  assertEquals(hit?.outcomes[0].category, "sanctions");
  assertEquals(hit?.outcomes[0].amountUsdc, 0.001);
  assertEquals(hit?.totalSpentUsdc, 0.001);
  assertEquals(hit?.totalLlmCostUsd, 0.002);
  assertEquals(hit?.walletNetwork, "base");
});

Deno.test("memoryCache: address lookup is case-insensitive", async () => {
  const c = memoryCache();
  const e = makeEntry(
    "safe_to_transact",
    "0xABC000000000000000000000000000000000CAFE",
  );
  await c.set("eth", e.verdict.address, e);
  const hit = await c.get("eth", e.verdict.address.toLowerCase());
  assertEquals(hit?.verdict.verdict, "safe_to_transact");
});

Deno.test("memoryCache: do_not_transact is cached", async () => {
  const c = memoryCache();
  const e = makeEntry("do_not_transact");
  await c.set("eth", e.verdict.address, e);
  assertEquals(
    (await c.get("eth", e.verdict.address))?.verdict.verdict,
    "do_not_transact",
  );
});

Deno.test("memoryCache: insufficient_data is never cached", async () => {
  const c = memoryCache();
  const e = makeEntry("insufficient_data");
  await c.set("eth", e.verdict.address, e);
  assertEquals(await c.get("eth", e.verdict.address), null);
});

Deno.test("memoryCache: different chains are independent keys", async () => {
  const c = memoryCache();
  const addr = "0xABC0000000000000000000000000000000000123";
  await c.set("eth", addr, makeEntry("safe_to_transact", addr));
  await c.set("base", addr, makeEntry("do_not_transact", addr));
  assertEquals((await c.get("eth", addr))?.verdict.verdict, "safe_to_transact");
  assertEquals((await c.get("base", addr))?.verdict.verdict, "do_not_transact");
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
  // The cache hit is flagged and carries the original run's receipts + cost
  // totals so the UI can render the same paid-services breakdown ($0 charged
  // this run is conveyed via fromCache, not by zeroing the receipts).
  assertEquals(r2.fromCache, true);
  assertEquals(r2.outcomes.length, 1, "cached receipts must be preserved");
  assertEquals(r2.outcomes[0].category, "sanctions");
  assertEquals(r2.totalSpentUsdc, 0.001, "original x402 spend preserved");
  // First (fresh) call is not flagged as cached.
  assertEquals(r1.fromCache ?? false, false);
});

Deno.test("verdict_cache: do_not_transact TTL is distinct from safe_to_transact (both cached)", async () => {
  const cache = memoryCache();

  // Prime with do_not_transact.
  await cache.set("eth", ADDR, makeEntry("do_not_transact", ADDR));

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
