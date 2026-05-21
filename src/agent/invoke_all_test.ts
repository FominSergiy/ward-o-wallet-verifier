import { assertEquals, assertRejects } from "@std/assert";
import { invokeAll, SanctionsInvocationError } from "./invoke_all.ts";
import type { ServiceInvocationOutcome } from "./invoke_service.ts";
import type { DiscoveryPlan, RankedService } from "../discovery/types.ts";
import type { Category } from "./types.ts";

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
  const invoker = (_s: RankedService) =>
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

Deno.test("invokeAll echoes walletNetwork in result", async () => {
  const services = [svc("sanctions", "https://s")];
  const r = await invokeAll(plan(services), "base", {
    invoker: () => Promise.resolve(okOutcome("sanctions", { ok: true })),
  });
  assertEquals(r.walletNetwork, "base");
});
