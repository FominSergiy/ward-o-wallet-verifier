import { assertEquals, assertRejects } from "@std/assert";
import { invokeAll, SanctionsInvocationError } from "./invoke_all.ts";
import type { ServiceInvocationOutcome } from "./invoke_service.ts";
import type { DiscoveryPlan, RankedService } from "../discovery/types.ts";
import type { Category } from "./types.ts";
import {
  _resetHealthStoreForTests,
  readHealth,
} from "../discovery/health_store.ts";

function withTempHealthStore(fn: () => Promise<void>): Promise<void> {
  const tmp = Deno.makeTempFileSync({ suffix: ".json" });
  Deno.env.set("HEALTH_STORE_PATH", tmp);
  _resetHealthStoreForTests();
  return fn().finally(() => {
    Deno.env.delete("HEALTH_STORE_PATH");
    try {
      Deno.removeSync(tmp);
    } catch {
      // ignore
    }
  });
}

function svc(category: Category, resource: string): RankedService {
  return {
    category,
    resource,
    description: "x",
    priceUsdc: 0.001,
    network: "eip155:8453",
    payTo: "0xpay",
    scheme: "exact",
    qualityScore: null,
    rationale: "r",
  };
}

function plan(services: RankedService[]): DiscoveryPlan {
  return {
    address: "0xABC",
    walletNetwork: "base",
    services,
    alternates: {},
    totalEstimatedCostUsdc: services.reduce((s, x) => s + x.priceUsdc, 0),
    unresolvedCategories: [],
    generatedAt: new Date().toISOString(),
  };
}

function okOutcome(category: Category, data: unknown, amountUsdc = 0.001): ServiceInvocationOutcome {
  return {
    category,
    resource: `https://${category}.example`,
    data,
    status: "ok",
    amountUsdc,
    durationMs: 5,
    paid: true,
    network: "base",
    adapterPath: "pattern",
  };
}

function errorOutcome(category: Category, msg: string): ServiceInvocationOutcome {
  return {
    category,
    resource: `https://${category}.example`,
    data: null,
    status: "error",
    error: msg,
    amountUsdc: 0,
    durationMs: 5,
    paid: false,
    network: null,
    adapterPath: "pattern",
  };
}

Deno.test("invokeAll runs services concurrently", async () => {
  const sleepMs = 50;
  const _invoker = (_s: RankedService) =>
    new Promise<ServiceInvocationOutcome>((resolve) =>
      setTimeout(() => resolve(okOutcome("sanctions", { ok: true })), sleepMs)
    );
  const services: RankedService[] = [
    svc("sanctions", "https://a"),
    svc("labels", "https://b"),
    svc("onchain_history", "https://c"),
    svc("web_sentiment", "https://d"),
    svc("contract_analysis", "https://e"),
  ];
  // Wrap invoker to return the correct category for each call:
  let callIdx = 0;
  const cats = services.map((s) => s.category);
  const wrapped = (_s: RankedService) =>
    new Promise<ServiceInvocationOutcome>((resolve) =>
      setTimeout(() => resolve(okOutcome(cats[callIdx++], { ok: true })), sleepMs)
    );
  const start = performance.now();
  await invokeAll(plan(services), "base", { invoker: wrapped });
  const elapsed = performance.now() - start;
  // 5 calls × 50ms = 250ms if sequential. Parallel should be ~50–80ms.
  assertEquals(elapsed < 150, true, `expected parallel ~50ms, got ${elapsed}ms`);
});

Deno.test("invokeAll throws SanctionsInvocationError when sanctions fails", async () => {
  const services = [svc("sanctions", "https://s"), svc("labels", "https://l")];
  const invoker = (s: RankedService) =>
    Promise.resolve(
      s.category === "sanctions"
        ? errorOutcome("sanctions", "upstream timeout")
        : okOutcome("labels", ["exchange"]),
    );
  await assertRejects(
    () => invokeAll(plan(services), "base", { invoker }),
    SanctionsInvocationError,
    "upstream timeout",
  );
});

Deno.test("invokeAll returns partial findings when non-sanctions services fail", async () => {
  const services = [
    svc("sanctions", "https://s"),
    svc("labels", "https://l"),
    svc("onchain_history", "https://o"),
  ];
  const invoker = (s: RankedService) =>
    Promise.resolve(
      s.category === "labels"
        ? errorOutcome("labels", "bad request")
        : okOutcome(s.category, { ok: true }),
    );
  const r = await invokeAll(plan(services), "base", { invoker });
  assertEquals("sanctions" in r.findings, true);
  assertEquals("onchain_history" in r.findings, true);
  assertEquals("labels" in r.findings, false);
  assertEquals(r.unresolved, ["labels"]);
});

Deno.test("invokeAll sums totalSpentUsdc across successful calls", async () => {
  const services = [
    svc("sanctions", "https://s"),
    svc("labels", "https://l"),
    svc("onchain_history", "https://o"),
  ];
  const invoker = (s: RankedService) => {
    const amounts: Record<string, number> = {
      sanctions: 0.001,
      labels: 0.002,
      onchain_history: 0.0007,
    };
    return Promise.resolve(okOutcome(s.category, { ok: true }, amounts[s.category]));
  };
  const r = await invokeAll(plan(services), "base", { invoker });
  assertEquals(Math.abs(r.totalSpentUsdc - 0.0037) < 1e-9, true);
});

Deno.test("invokeAll proceeds when sanctions is absent from plan", async () => {
  const services = [svc("labels", "https://l")];
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const r = await invokeAll(plan(services), "base", {
      invoker: () => Promise.resolve(okOutcome("labels", ["exchange"])),
    });
    assertEquals(r.findings.labels, ["exchange"]);
    assertEquals(
      warnings.some((w) => w.includes("sanctions not in plan")),
      true,
    );
  } finally {
    console.warn = origWarn;
  }
});

Deno.test("invokeAll skips same-host alternates after domain-level error", async () => {
  // Primary + 2 alternates all on the same host.
  const services = [svc("onchain_history", "https://orbisapi.com/proxy/v1/main")];
  const planWithAlts: DiscoveryPlan = {
    ...plan(services),
    alternates: {
      onchain_history: [
        svc("onchain_history", "https://orbisapi.com/proxy/v1/balance"),
        svc("onchain_history", "https://orbisapi.com/proxy/v1/tokens"),
      ],
    },
  };
  const calls: string[] = [];
  const invoker = (s: RankedService) => {
    calls.push(s.resource);
    return Promise.resolve({
      category: s.category,
      resource: s.resource,
      data: null,
      status: "error" as const,
      error: "agnicFetch [Target API is not X402 enabled]: Bad Request",
      amountUsdc: 0,
      durationMs: 5,
      paid: false,
      network: null,
      adapterPath: "pattern" as const,
    });
  };
  // Sanctions has to be present + ok or invokeAll throws — supply a stub.
  const planFull: DiscoveryPlan = {
    ...planWithAlts,
    services: [
      svc("sanctions", "https://sanc.example"),
      ...services,
    ],
  };
  await invokeAll(planFull, "base", {
    invoker: (s) => {
      if (s.category === "sanctions") return Promise.resolve(okOutcome("sanctions", { ok: true }));
      return invoker(s);
    },
    disableViemFallback: true,
  });
  // Only the primary should have been called for onchain — alternates skipped.
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "https://orbisapi.com/proxy/v1/main");
});

Deno.test("invokeAll still tries different-host alternates after domain-level error", async () => {
  const services = [svc("onchain_history", "https://orbisapi.com/proxy/v1/main")];
  const planWithAlts: DiscoveryPlan = {
    ...plan([svc("sanctions", "https://sanc.example"), ...services]),
    alternates: {
      onchain_history: [
        svc("onchain_history", "https://orbisapi.com/proxy/v1/balance"), // same host — skip
        svc("onchain_history", "https://other-provider.example/onchain"), // different host — try
      ],
    },
  };
  const calls: string[] = [];
  const invoker = (s: RankedService) => {
    calls.push(s.resource);
    if (s.category === "sanctions") return Promise.resolve(okOutcome("sanctions", { ok: true }));
    if (s.resource.includes("other-provider")) {
      return Promise.resolve(okOutcome("onchain_history", { txCount: 5 }));
    }
    return Promise.resolve({
      category: s.category,
      resource: s.resource,
      data: null,
      status: "error" as const,
      error: "agnicFetch [Target API is not X402 enabled]: Bad Request",
      amountUsdc: 0,
      durationMs: 5,
      paid: false,
      network: null,
      adapterPath: "pattern" as const,
    });
  };
  const r = await invokeAll(planWithAlts, "base", { invoker });
  // Primary on orbisapi → error. Same-host alt skipped. Different-host alt → success.
  assertEquals(
    calls.includes("https://orbisapi.com/proxy/v1/main"),
    true,
  );
  assertEquals(
    calls.includes("https://orbisapi.com/proxy/v1/balance"),
    false,
    "same-host alt should be skipped",
  );
  assertEquals(
    calls.includes("https://other-provider.example/onchain"),
    true,
  );
  assertEquals(r.findings.onchain_history, { txCount: 5 });
});

Deno.test("invokeAll records ok in the health store on success", async () => {
  await withTempHealthStore(async () => {
    const services = [svc("sanctions", "https://sanc.example")];
    await invokeAll(plan(services), "base", {
      invoker: (s) => Promise.resolve(okOutcome(s.category, { ok: true })),
    });
    const health = readHealth();
    assertEquals(health["https://sanc.example"]?.ok, 1);
    assertEquals(health["https://sanc.example"]?.err ?? 0, 0);
  });
});

Deno.test("invokeAll runs viem fallback when onchain_history x402 fails on eth", async () => {
  await withTempHealthStore(async () => {
    const services = [
      svc("sanctions", "https://sanc.example"),
      svc("onchain_history", "https://dead-onchain.example"),
    ];
    const invoker = (s: RankedService) => {
      if (s.category === "sanctions") return Promise.resolve(okOutcome("sanctions", { ok: true }));
      return Promise.resolve(errorOutcome("onchain_history", "Target API is not X402 enabled"));
    };
    let viemCalled = false;
    const r = await invokeAll(plan(services), "eth", {
      invoker,
      onchainViemFetcher: (address, chain) => {
        viemCalled = true;
        return Promise.resolve({
          source: "viem" as const,
          chain,
          address,
          txCount: 17,
          balanceWei: "1000000000000000000",
          balanceEth: 1.0,
          currentBlock: 100,
          rpcUrl: "https://stub-rpc",
        });
      },
    });
    assertEquals(viemCalled, true);
    assertEquals(r.findings.onchain_history !== undefined, true);
    const data = r.findings.onchain_history as { source: string; txCount: number };
    assertEquals(data.source, "viem");
    assertEquals(data.txCount, 17);
    // onchain_history should no longer be in unresolved.
    assertEquals(r.unresolved.includes("onchain_history"), false);
    // viem call is free — total spend matches the successful sanctions call only.
    assertEquals(r.totalSpentUsdc, 0.001);
  });
});

Deno.test("invokeAll skips viem fallback when onchain_history x402 succeeded", async () => {
  await withTempHealthStore(async () => {
    const services = [
      svc("sanctions", "https://sanc.example"),
      svc("onchain_history", "https://working-onchain.example"),
    ];
    let viemCalled = false;
    const r = await invokeAll(plan(services), "eth", {
      invoker: (s) => Promise.resolve(okOutcome(s.category, { from: "x402" })),
      onchainViemFetcher: () => {
        viemCalled = true;
        throw new Error("should not be called");
      },
    });
    assertEquals(viemCalled, false);
    const data = r.findings.onchain_history as { from: string };
    assertEquals(data.from, "x402");
  });
});

Deno.test("invokeAll leaves onchain_history unresolved when viem fallback also fails", async () => {
  await withTempHealthStore(async () => {
    const services = [
      svc("sanctions", "https://sanc.example"),
      svc("onchain_history", "https://dead-onchain.example"),
    ];
    const r = await invokeAll(plan(services), "eth", {
      invoker: (s) =>
        Promise.resolve(
          s.category === "sanctions"
            ? okOutcome("sanctions", { ok: true })
            : errorOutcome("onchain_history", "Not Found"),
        ),
      onchainViemFetcher: () => Promise.reject(new Error("rpc down")),
    });
    assertEquals(r.unresolved.includes("onchain_history"), true);
    assertEquals(r.findings.onchain_history, undefined);
  });
});

Deno.test("invokeAll records err in the health store on failure", async () => {
  await withTempHealthStore(async () => {
    const services = [
      svc("sanctions", "https://sanc-ok.example"),
      svc("labels", "https://labels-fail.example"),
    ];
    const invoker = (s: RankedService) =>
      Promise.resolve(
        s.category === "sanctions"
          ? okOutcome("sanctions", { ok: true })
          : errorOutcome("labels", "Bad Request"),
      );
    await invokeAll(plan(services), "base", { invoker });
    const health = readHealth();
    assertEquals(health["https://sanc-ok.example"]?.ok, 1);
    assertEquals(health["https://labels-fail.example"]?.err, 1);
    assertEquals(
      health["https://labels-fail.example"]?.lastError?.includes("Bad Request"),
      true,
    );
  });
});

Deno.test("invokeAll echoes walletNetwork in result", async () => {
  const services = [svc("sanctions", "https://s")];
  const r = await invokeAll(plan(services), "base", {
    invoker: () => Promise.resolve(okOutcome("sanctions", { ok: true })),
  });
  assertEquals(r.walletNetwork, "base");
});
