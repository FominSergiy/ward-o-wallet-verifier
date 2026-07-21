import { assertEquals } from "@std/assert";
import { probeProbationCandidates } from "./probe.ts";
import type { ProbeOpts } from "./probe.ts";
import type { RegistryEntry } from "../registry/types.ts";
import { ServiceStatus } from "../db/enums.ts";
import { SanctionsInvocationError } from "../agent/invoke_all.ts";

// Two fixtures is enough to exercise per-candidate fan-out without noise.
const FIXTURES = [{ address: "0xaaa" }, { address: "0xbbb" }];

function entry(
  resource: string,
  priceUsdc: number,
  overrides: Partial<RegistryEntry> = {},
): RegistryEntry {
  return {
    id: resource,
    service_id: "",
    resource,
    category: "sanctions",
    price_usdc: priceUsdc,
    status: ServiceStatus.PROBATION,
    score: 0.25,
    last_vetted_at: null,
    method: "GET",
    query_params: null,
    path_params: null,
    body_schema: null,
    body_type: null,
    ...overrides,
  };
}

// A recording invoke seam: logs the (resource, address) of each call and
// reports the service's own price as spend, like a real paid invocation.
function recordingInvoke() {
  const calls: Array<{ resource: string; address: string }> = [];
  const invoke: ProbeOpts["invoke"] = (plan, _chain, _o) => {
    const svc = plan.services[0];
    calls.push({ resource: svc.resource, address: plan.address });
    return Promise.resolve({ totalSpentUsdc: svc.priceUsdc });
  };
  return { calls, invoke };
}

const baseOpts = (
  over: Partial<ProbeOpts> & Pick<ProbeOpts, "budgetUsdc" | "minBalanceUsdc">,
): ProbeOpts => ({
  maxPriceUsdc: 1, // out of the way unless a test opts in
  fixtures: FIXTURES,
  fetchBalance: () => Promise.resolve(1000),
  ...over,
});

Deno.test("probe: budget 0 is a no-op (never invokes, never reads candidates)", async () => {
  const { calls, invoke } = recordingInvoke();
  let fetchedProbation = false;
  const res = await probeProbationCandidates(baseOpts({
    budgetUsdc: 0,
    minBalanceUsdc: 0,
    invoke,
    fetchProbation: () => {
      fetchedProbation = true;
      return Promise.resolve([entry("https://a.example", 0.01)]);
    },
  }));

  assertEquals(calls.length, 0);
  assertEquals(fetchedProbation, false);
  assertEquals(res, {
    probed: 0,
    skipped: 0,
    spendUsdc: 0,
    belowFloor: false,
    observations: 0,
  });
});

Deno.test("probe: balance below floor skips the whole phase", async () => {
  const { calls, invoke } = recordingInvoke();
  const res = await probeProbationCandidates(baseOpts({
    budgetUsdc: 1,
    minBalanceUsdc: 5,
    fetchBalance: () => Promise.resolve(4.99),
    invoke,
    fetchProbation: () => Promise.resolve([entry("https://a.example", 0.01)]),
  }));

  assertEquals(res.belowFloor, true);
  assertEquals(res.observations, 0);
  assertEquals(calls.length, 0);
});

Deno.test("probe: undeterminable balance proceeds (ceiling still bounds spend)", async () => {
  const { calls, invoke } = recordingInvoke();
  const res = await probeProbationCandidates(baseOpts({
    budgetUsdc: 1,
    minBalanceUsdc: 5,
    fetchBalance: () => Promise.resolve(null),
    invoke,
    fetchProbation: () => Promise.resolve([entry("https://a.example", 0.01)]),
  }));

  assertEquals(res.belowFloor, false);
  assertEquals(res.probed, 1);
  assertEquals(calls.length, 2); // 2 fixtures
});

Deno.test("probe: candidates over the price cap are skipped", async () => {
  const { calls, invoke } = recordingInvoke();
  const res = await probeProbationCandidates(baseOpts({
    budgetUsdc: 10,
    minBalanceUsdc: 0,
    maxPriceUsdc: 0.10,
    invoke,
    fetchProbation: () =>
      Promise.resolve([
        entry("https://cheap.example", 0.02),
        entry("https://pricey.example", 0.50), // above the 0.10 cap
      ]),
  }));

  assertEquals(res.probed, 1);
  assertEquals(res.skipped, 1);
  assertEquals(calls.map((c) => c.resource), [
    "https://cheap.example",
    "https://cheap.example",
  ]);
});

Deno.test("probe: cheapest candidate is probed first", async () => {
  const { calls, invoke } = recordingInvoke();
  await probeProbationCandidates(baseOpts({
    budgetUsdc: 10,
    minBalanceUsdc: 0,
    invoke,
    fetchProbation: () =>
      Promise.resolve([
        entry("https://dear.example", 0.05),
        entry("https://cheap.example", 0.01),
      ]),
  }));

  // First fixture call must be for the cheaper resource.
  assertEquals(calls[0].resource, "https://cheap.example");
});

Deno.test("probe: stops before the per-run ceiling is exceeded", async () => {
  const { calls, invoke } = recordingInvoke();
  // budget 0.03; 2 fixtures each. cheap=0.01 → predicted 0.02 (fits);
  // dear=0.05 → predicted 0.10 (0.02+0.10 > 0.03) → skipped.
  const res = await probeProbationCandidates(baseOpts({
    budgetUsdc: 0.03,
    minBalanceUsdc: 0,
    invoke,
    fetchProbation: () =>
      Promise.resolve([
        entry("https://cheap.example", 0.01),
        entry("https://dear.example", 0.05),
      ]),
  }));

  assertEquals(res.probed, 1);
  assertEquals(res.skipped, 1);
  assertEquals(res.observations, 2);
  // 2 fixtures × $0.01
  assertEquals(Number(res.spendUsdc.toFixed(6)), 0.02);
  assertEquals(
    calls.every((c) => c.resource === "https://cheap.example"),
    true,
  );
});

Deno.test("probe: records one observation per fixture per probed candidate", async () => {
  const { calls, invoke } = recordingInvoke();
  const res = await probeProbationCandidates(baseOpts({
    budgetUsdc: 10,
    minBalanceUsdc: 0,
    invoke,
    fetchProbation: () =>
      Promise.resolve([
        entry("https://a.example", 0.01),
        entry("https://b.example", 0.01),
      ]),
  }));

  assertEquals(res.probed, 2);
  assertEquals(res.observations, 4); // 2 candidates × 2 fixtures
  assertEquals(calls.length, 4);
});

Deno.test("probe: a sanctions fail-fast is caught; the loop keeps going", async () => {
  // The first candidate's invoke throws (observation already recorded upstream);
  // probe must swallow it, count the observation, and continue to the next.
  const seen: string[] = [];
  const invoke: ProbeOpts["invoke"] = (plan) => {
    seen.push(plan.services[0].resource);
    if (plan.services[0].resource === "https://boom.example") {
      return Promise.reject(new SanctionsInvocationError("upstream 500"));
    }
    return Promise.resolve({ totalSpentUsdc: plan.services[0].priceUsdc });
  };

  const res = await probeProbationCandidates(baseOpts({
    budgetUsdc: 10,
    minBalanceUsdc: 0,
    fixtures: [{ address: "0xaaa" }],
    invoke,
    fetchProbation: () =>
      Promise.resolve([
        entry("https://boom.example", 0.01),
        entry("https://ok.example", 0.02),
      ]),
  }));

  assertEquals(res.probed, 2);
  assertEquals(res.observations, 2); // both fixtures counted despite the throw
  assertEquals(seen, ["https://boom.example", "https://ok.example"]);
});

Deno.test("probe: denied-host candidates are never invoked", async () => {
  const prev = Deno.env.get("DISCOVERY_HOST_DENYLIST");
  Deno.env.set("DISCOVERY_HOST_DENYLIST", "denied.example");
  try {
    const { calls, invoke } = recordingInvoke();
    const res = await probeProbationCandidates(baseOpts({
      budgetUsdc: 10,
      minBalanceUsdc: 0,
      invoke,
      fetchProbation: () =>
        Promise.resolve([
          entry("https://denied.example/screen", 0.01),
          entry("https://live.example/screen", 0.01),
        ]),
    }));

    assertEquals(res.probed, 1);
    assertEquals(
      calls.every((c) => c.resource === "https://live.example/screen"),
      true,
    );
  } finally {
    if (prev === undefined) Deno.env.delete("DISCOVERY_HOST_DENYLIST");
    else Deno.env.set("DISCOVERY_HOST_DENYLIST", prev);
  }
});
