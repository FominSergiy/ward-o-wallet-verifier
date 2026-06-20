import { assertEquals } from "@std/assert";
import { selectFromRegistry } from "./select.ts";
import type { CallRecipe, RegistryEntry } from "./types.ts";
import type { Category } from "../agent/types.ts";

const CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "ens",
];

function recipe(
  service_id: string,
  category: Category,
  resource: string,
  price = 0.001,
): CallRecipe {
  return {
    service_id,
    category,
    resource,
    method: "GET",
    query_params: { wallet: "0xexample" },
    pay_to: "0xpayto",
    network: "eip155:8453",
    price_usdc: price,
    snapshotted_at: new Date().toISOString(),
  };
}

function entry(
  service_id: string,
  category: string,
  resource: string,
  score: number,
): RegistryEntry {
  return {
    id: crypto.randomUUID(),
    service_id,
    resource,
    category,
    price_usdc: 0.001,
    status: "active",
    score,
    last_vetted_at: new Date(),
  };
}

const RECIPES: Record<string, CallRecipe> = {
  sanc1: recipe("sanc1", "sanctions", "https://sanc-a.example/screen"),
  sanc2: recipe("sanc2", "sanctions", "https://sanc-b.example/screen"),
  lab1: recipe("lab1", "labels", "https://labels.example/lookup"),
  hist1: recipe("hist1", "onchain_history", "https://hist.example/balance"),
  senti1: recipe("senti1", "web_sentiment", "https://senti.example/news"),
};

Deno.test("selectFromRegistry: offline fallback uses every recipe at score 1.0", async () => {
  // No getActive override + empty DB simulated by returning [] → recipe file
  // becomes the active set.
  const plan = await selectFromRegistry("0xabc", CATEGORIES, {
    loadRecipes: () => Promise.resolve(RECIPES),
    getActive: () => Promise.resolve([]),
  });

  // One primary service per x402 category (ens is a chain-primitive, excluded).
  const cats = plan.services.map((s) => s.category).sort();
  assertEquals(cats, [
    "labels",
    "onchain_history",
    "sanctions",
    "web_sentiment",
  ]);
  assertEquals(plan.unresolvedCategories, []);
  // sanctions has two recipes → one primary + one alternate.
  assertEquals(plan.alternates.sanctions?.length, 1);
  assertEquals(plan.totalEstimatedCostUsdc, 0.004);
});

Deno.test("selectFromRegistry: ranks by registry score descending within a category", async () => {
  const plan = await selectFromRegistry("0xabc", ["sanctions"], {
    loadRecipes: () => Promise.resolve(RECIPES),
    // sanc2 outscores sanc1 → sanc2 must be the primary.
    getActive: () =>
      Promise.resolve([
        entry("sanc2", "sanctions", "https://sanc-b.example/screen", 0.91),
        entry("sanc1", "sanctions", "https://sanc-a.example/screen", 0.42),
      ]),
  });

  assertEquals(plan.services.length, 1);
  assertEquals(plan.services[0].resource, "https://sanc-b.example/screen");
  assertEquals(
    plan.alternates.sanctions?.[0].resource,
    "https://sanc-a.example/screen",
  );
});

Deno.test("selectFromRegistry: category with no active service is unresolved", async () => {
  const plan = await selectFromRegistry("0xabc", ["sanctions", "labels"], {
    loadRecipes: () => Promise.resolve(RECIPES),
    getActive: () =>
      Promise.resolve([
        entry("sanc1", "sanctions", "https://sanc-a.example/screen", 1.0),
      ]),
  });

  assertEquals(plan.services.map((s) => s.category), ["sanctions"]);
  assertEquals(plan.unresolvedCategories, ["labels"]);
});

Deno.test("selectFromRegistry: skips active rows with no matching recipe", async () => {
  const plan = await selectFromRegistry("0xabc", ["sanctions"], {
    loadRecipes: () => Promise.resolve(RECIPES),
    getActive: () =>
      Promise.resolve([
        entry("ghost", "sanctions", "https://ghost.example", 1.0),
        entry("sanc1", "sanctions", "https://sanc-a.example/screen", 0.5),
      ]),
  });

  // ghost has no recipe → skipped; sanc1 becomes the primary.
  assertEquals(plan.services.length, 1);
  assertEquals(plan.services[0].resource, "https://sanc-a.example/screen");
});

Deno.test("selectFromRegistry: reconstructs invocation call shape from recipe", async () => {
  const plan = await selectFromRegistry("0xabc", ["sanctions"], {
    loadRecipes: () => Promise.resolve(RECIPES),
    getActive: () => Promise.resolve([]),
  });

  const svc = plan.services[0];
  assertEquals(svc.payTo, "0xpayto");
  assertEquals(svc.network, "eip155:8453");
  assertEquals(svc.inputInfo?.method, "GET");
  assertEquals(svc.inputInfo?.queryParams, { wallet: "0xexample" });
});

Deno.test(
  "selectFromRegistry: blocked service never appears regardless of score",
  async () => {
    const plan = await selectFromRegistry("0xabc", ["sanctions"], {
      loadRecipes: () => Promise.resolve(RECIPES),
      // sanc2 is blocked but has a higher score — must be excluded.
      // sanc1 is active at a lower score — must be the primary.
      getActive: () =>
        Promise.resolve([
          {
            ...entry(
              "sanc2",
              "sanctions",
              "https://sanc-b.example/screen",
              0.95,
            ),
            status: "blocked",
          },
          entry("sanc1", "sanctions", "https://sanc-a.example/screen", 0.42),
        ]),
    });

    assertEquals(plan.services.length, 1);
    assertEquals(plan.services[0].resource, "https://sanc-a.example/screen");
  },
);

Deno.test("selectFromRegistry: never invokes searchDiscovery (Bazaar)", async () => {
  // Guard the architectural invariant: a registry selection must not reach
  // through to the Bazaar discovery client. We stub globalThis.fetch to throw
  // on any CDP discovery call and assert selection completes cleanly.
  const originalFetch = globalThis.fetch;
  let bazaarCalls = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.includes("x402/discovery/search")) bazaarCalls++;
    throw new Error(`unexpected network call: ${url}`);
  }) as typeof fetch;

  try {
    const plan = await selectFromRegistry("0xabc", CATEGORIES, {
      loadRecipes: () => Promise.resolve(RECIPES),
      getActive: () => Promise.resolve([]),
    });
    assertEquals(plan.services.length > 0, true);
    assertEquals(bazaarCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
