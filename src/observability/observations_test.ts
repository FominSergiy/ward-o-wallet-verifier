import { assertEquals } from "@std/assert";
import { recordServiceObservation } from "./observations.ts";
import type { ServiceEvent } from "../agent/events.ts";
import type { RankedService } from "../discovery/types.ts";

function makeEvent(overrides: Partial<ServiceEvent> = {}): ServiceEvent {
  return {
    type: "service",
    status: "ok",
    category: "sanctions",
    resource: "https://example.com/sanctions",
    request_id: "req-test-0001",
    duration_ms: 150,
    cost_usd: 0.001,
    at: new Date().toISOString(),
    ...overrides,
  };
}

function makeService(
  category: RankedService["category"],
  slug: string,
): RankedService {
  return {
    category,
    resource: `https://example.com/${slug}`,
    description: `${slug} service`,
    priceUsdc: 0.001,
    network: "base",
    payTo: "0x0000",
    scheme: "exact",
    qualityScore: null,
    rationale: "test",
  };
}

Deno.test("recordServiceObservation: start events are silently skipped", () => {
  // start events must return before touching the DB (no-op early return)
  recordServiceObservation(makeEvent({ status: "start" }));
});

Deno.test("recordServiceObservation: ok event does not throw", () => {
  recordServiceObservation(makeEvent({ status: "ok" }));
});

Deno.test("recordServiceObservation: error event does not throw", () => {
  recordServiceObservation(
    makeEvent({ status: "error", error: "upstream_timeout", cost_usd: null }),
  );
});

Deno.test("recordServiceObservation: fallback event does not throw", () => {
  recordServiceObservation(
    makeEvent({ status: "fallback", error: "upstream_404", cost_usd: null }),
  );
});

Deno.test(
  "invokeAll: DB write failure does not throw out of verify call",
  async () => {
    const { invokeAll } = await import("../agent/invoke_all.ts");

    const fakePlan = {
      address: "0xABC",
      walletNetwork: "base" as const,
      services: [makeService("sanctions", "sanctions")],
      alternates: {},
      totalEstimatedCostUsdc: 0.001,
      unresolvedCategories: [],
      deterministicSources: [],
      generatedAt: new Date().toISOString(),
    };

    const events: string[] = [];
    let threw = false;
    try {
      await invokeAll(fakePlan, "eth", {
        invoker: () =>
          Promise.resolve({
            category: "sanctions" as const,
            resource: "https://example.com/sanctions",
            data: { isSanctioned: false },
            status: "ok" as const,
            amountUsdc: 0.001,
            durationMs: 10,
            paid: true,
            network: "eth" as const,
            adapterPath: "llm" as const,
          }),
        disableViemFallback: true,
        onEvent: (e) => events.push(e.type),
        request_id: "req-fail-test",
      });
    } catch {
      threw = true;
    }

    assertEquals(threw, false, "invokeAll must not throw due to DB write");
    assertEquals(
      events.filter((t) => t === "service").length > 0,
      true,
      "service events were emitted",
    );
  },
);

Deno.test(
  "invokeAll: produces N ok service events for N services in the plan",
  async () => {
    const { invokeAll } = await import("../agent/invoke_all.ts");

    const categories = [
      "sanctions",
      "labels",
      "onchain_history",
    ] as const satisfies RankedService["category"][];

    const fakePlan = {
      address: "0xDEF",
      walletNetwork: "base" as const,
      services: categories.map((cat) => makeService(cat, cat)),
      alternates: {},
      totalEstimatedCostUsdc: 0.003,
      unresolvedCategories: [],
      deterministicSources: [],
      generatedAt: new Date().toISOString(),
    };

    const okResources: string[] = [];
    await invokeAll(fakePlan, "eth", {
      invoker: (svc) =>
        Promise.resolve({
          category: svc.category,
          resource: svc.resource,
          data: { ok: true },
          status: "ok" as const,
          amountUsdc: 0.001,
          durationMs: 5,
          paid: true,
          network: "eth" as const,
          adapterPath: "llm" as const,
        }),
      disableViemFallback: true,
      onEvent: (e) => {
        if (e.type === "service" && e.status === "ok") {
          okResources.push(e.resource);
        }
      },
      request_id: "req-count-test",
    });

    assertEquals(
      okResources.length,
      categories.length,
      `expected ${categories.length} ok events, got ${okResources.length}`,
    );
  },
);
