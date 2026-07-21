import { assertEquals, assertRejects } from "@std/assert";
import { RegistryUnavailableError, selectFromRegistry } from "./select.ts";
import type { CallRecipe, RegistryEntry } from "./types.ts";
import type { Category } from "../agent/types.ts";
import { ServiceStatus } from "../db/enums.ts";

const CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "ens",
];

// ── DATABASE_URL toggle ───────────────────────────────────────────────────────
// selectFromRegistry branches on dbEnabled() (DATABASE_URL presence): set → the
// DB path (getActive seam); unset → the offline recipe-file path. Each test
// pins the env it needs and restores the prior value. dbEnabled() reads the env
// directly, and the getActive seam means no socket is ever opened, so a dummy
// value is safe.
function withDb<T>(fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get("DATABASE_URL");
  Deno.env.set("DATABASE_URL", "postgres://seam-not-used");
  return fn().finally(() => {
    if (prev === undefined) Deno.env.delete("DATABASE_URL");
    else Deno.env.set("DATABASE_URL", prev);
  });
}

function withoutDb<T>(fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get("DATABASE_URL");
  Deno.env.delete("DATABASE_URL");
  return fn().finally(() => {
    if (prev !== undefined) Deno.env.set("DATABASE_URL", prev);
  });
}

// Any call to the recipe loader in a DB-path test is a bug: production must
// never consult the checked-in recipe sample.
function recipeLoaderMustNotRun(): Promise<Record<string, CallRecipe>> {
  throw new Error("recipe file must not be read on the DB path");
}

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
  status: ServiceStatus = ServiceStatus.ACTIVE,
): RegistryEntry {
  return {
    id: crypto.randomUUID(),
    service_id,
    resource,
    category,
    price_usdc: 0.001,
    status,
    score,
    last_vetted_at: new Date(),
    method: "GET",
    query_params: { wallet: "0xexample" },
    path_params: null,
    body_schema: null,
    body_type: null,
  };
}

const RECIPES: Record<string, CallRecipe> = {
  sanc1: recipe("sanc1", "sanctions", "https://sanc-a.example/screen"),
  sanc2: recipe("sanc2", "sanctions", "https://sanc-b.example/screen"),
  lab1: recipe("lab1", "labels", "https://labels.example/lookup"),
  hist1: recipe("hist1", "onchain_history", "https://hist.example/balance"),
  senti1: recipe("senti1", "web_sentiment", "https://senti.example/news"),
};

// ── (d) offline path — DATABASE_URL unset ─────────────────────────────────────

Deno.test("selectFromRegistry: offline fallback uses every recipe at score 1.0", () =>
  withoutDb(async () => {
    const plan = await selectFromRegistry("0xabc", CATEGORIES, {
      loadRecipes: () => Promise.resolve(RECIPES),
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
  }));

Deno.test("selectFromRegistry: offline path reconstructs call shape from recipe", () =>
  withoutDb(async () => {
    const plan = await selectFromRegistry("0xabc", ["sanctions"], {
      loadRecipes: () => Promise.resolve(RECIPES),
    });

    const svc = plan.services[0];
    assertEquals(svc.payTo, "0xpayto");
    assertEquals(svc.network, "eip155:8453");
    assertEquals(svc.inputInfo?.method, "GET");
    assertEquals(svc.inputInfo?.queryParams, { wallet: "0xexample" });
  }));

Deno.test("selectFromRegistry: never invokes searchDiscovery (Bazaar)", () =>
  withoutDb(async () => {
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
      });
      assertEquals(plan.services.length > 0, true);
      assertEquals(bazaarCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));

// ── (a) DB path — active ranks above probation; probation is a fallback ───────

Deno.test("selectFromRegistry: active ranks above probation; probation is a fallback alternate", () =>
  withDb(async () => {
    // getActiveServices() returns rows already ordered (active before
    // probation). A higher-scored PROBATION row must NOT overtake a lower-scored
    // ACTIVE one — select must preserve the tiered order, not re-sort by score.
    const plan = await selectFromRegistry("0xabc", ["sanctions"], {
      loadRecipes: recipeLoaderMustNotRun,
      getActive: () =>
        Promise.resolve([
          entry("sanc1", "sanctions", "https://active.example/screen", 0.5),
          entry(
            "sanc2",
            "sanctions",
            "https://probation.example/screen",
            0.9,
            ServiceStatus.PROBATION,
          ),
        ]),
    });

    assertEquals(plan.services.length, 1);
    assertEquals(plan.services[0].resource, "https://active.example/screen");
    assertEquals(
      plan.alternates.sanctions?.[0].resource,
      "https://probation.example/screen",
    );
  }));

Deno.test("selectFromRegistry: ranks by registry order within a category", () =>
  withDb(async () => {
    const plan = await selectFromRegistry("0xabc", ["sanctions"], {
      loadRecipes: recipeLoaderMustNotRun,
      // sanc2 outscores sanc1 → returned first by getActiveServices → primary.
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
  }));

Deno.test("selectFromRegistry: builds RankedService call shape from DB row columns", () =>
  withDb(async () => {
    const e = entry("hist1", "onchain_history", "https://hist.example/x", 0.7);
    e.method = "POST";
    e.query_params = null;
    e.body_schema = { address: "0xexample" };
    e.body_type = "json";
    const plan = await selectFromRegistry("0xabc", ["onchain_history"], {
      loadRecipes: recipeLoaderMustNotRun,
      getActive: () => Promise.resolve([e]),
    });

    const svc = plan.services[0];
    // network is pinned and payTo empty — neither is stored on the row nor
    // drives the HTTP call.
    assertEquals(svc.network, "eip155:8453");
    assertEquals(svc.payTo, "");
    assertEquals(svc.inputInfo?.method, "POST");
    assertEquals(svc.inputInfo?.body, { address: "0xexample" });
    assertEquals(svc.inputInfo?.bodyType, "json");
  }));

Deno.test("selectFromRegistry: category with no service is unresolved", () =>
  withDb(async () => {
    const plan = await selectFromRegistry("0xabc", ["sanctions", "labels"], {
      loadRecipes: recipeLoaderMustNotRun,
      getActive: () =>
        Promise.resolve([
          entry("sanc1", "sanctions", "https://sanc-a.example/screen", 1.0),
        ]),
    });

    assertEquals(plan.services.map((s) => s.category), ["sanctions"]);
    assertEquals(plan.unresolvedCategories, ["labels"]);
  }));

// ── (c) DB path — blocked is never selected ───────────────────────────────────

Deno.test("selectFromRegistry: blocked service never appears regardless of score", () =>
  withDb(async () => {
    const plan = await selectFromRegistry("0xabc", ["sanctions"], {
      loadRecipes: recipeLoaderMustNotRun,
      // sanc2 is blocked but has a higher score — must be excluded.
      // sanc1 is active at a lower score — must be the primary.
      getActive: () =>
        Promise.resolve([
          entry(
            "sanc2",
            "sanctions",
            "https://sanc-b.example/screen",
            0.95,
            ServiceStatus.BLOCKED,
          ),
          entry("sanc1", "sanctions", "https://sanc-a.example/screen", 0.42),
        ]),
    });

    assertEquals(plan.services.length, 1);
    assertEquals(plan.services[0].resource, "https://sanc-a.example/screen");
    assertEquals(plan.alternates.sanctions, undefined);
  }));

// ── (b) DB path — a read failure fails the request (no recipe fallback) ───────

Deno.test("selectFromRegistry: DB read failure throws RegistryUnavailableError (no recipe fallback)", () =>
  withDb(async () => {
    await assertRejects(
      () =>
        selectFromRegistry("0xabc", ["sanctions"], {
          // If the recipe file were consulted on failure this loader would run
          // and the rejection would not happen — proving no silent fallback.
          loadRecipes: recipeLoaderMustNotRun,
          getActive: () => Promise.reject(new Error("connection refused")),
        }),
      RegistryUnavailableError,
      "service registry unavailable",
    );
  }));

// ── (c) host denylist (A2) — defense-in-depth in selection ────────────────────
// Even if a denied-host row survives as active/probation in the DB, selection
// must never return it.

Deno.test("selectFromRegistry: a denied-host probation row is excluded", () =>
  withDb(async () => {
    const prev = Deno.env.get("DISCOVERY_HOST_DENYLIST");
    Deno.env.delete("DISCOVERY_HOST_DENYLIST"); // default denies orbisapi.com
    try {
      const plan = await selectFromRegistry("0xabc", ["sanctions"], {
        loadRecipes: recipeLoaderMustNotRun,
        // A live anchor row + a denied orbis probation row (higher score).
        getActive: () =>
          Promise.resolve([
            entry(
              "orbis1",
              "sanctions",
              "https://orbisapi.com/proxy/address-risk-api/screen",
              0.99,
              ServiceStatus.PROBATION,
            ),
            entry(
              "anchor1",
              "sanctions",
              "https://api.anchor-x402.com/v1/screen",
              0.50,
            ),
          ]),
      });
      // Orbis is filtered out → anchor is the only (primary) service.
      assertEquals(plan.services.length, 1);
      assertEquals(
        plan.services[0].resource,
        "https://api.anchor-x402.com/v1/screen",
      );
      assertEquals(plan.alternates.sanctions, undefined);
    } finally {
      if (prev === undefined) Deno.env.delete("DISCOVERY_HOST_DENYLIST");
      else Deno.env.set("DISCOVERY_HOST_DENYLIST", prev);
    }
  }));

// ── over-cap price filter — a service we can't pay for is never selected ───────
// A labels service priced above the per-call cap ($0.10) fails 100% with
// payment_exceeds_maximum, yet those failures are excluded from its score, so it
// keeps winning the primary slot. Selection must skip it entirely — from both
// the primary slot and the fallback alternates — so a cheaper payable candidate
// takes over.

Deno.test("selectFromRegistry: over-cap primary is skipped, cheaper payable candidate wins", () =>
  withDb(async () => {
    const overCap = entry(
      "lab-expensive",
      "labels",
      "https://x402-endpoints.onrender.com/crypto/wallet-forensics",
      0.90, // top score — would win on rank if price were ignored
    );
    overCap.price_usdc = 0.15; // above the $0.10 per-call cap
    const cheap = entry(
      "lab-cheap",
      "labels",
      "https://x402.agentutility.ai/wallet-label",
      0.25, // lower score, but payable
      ServiceStatus.PROBATION,
    );
    cheap.price_usdc = 0.005;

    const plan = await selectFromRegistry("0xabc", ["labels"], {
      loadRecipes: recipeLoaderMustNotRun,
      getActive: () => Promise.resolve([overCap, cheap]),
    });

    // Cheap payable candidate is the primary; over-cap one appears nowhere.
    assertEquals(plan.services.length, 1);
    assertEquals(
      plan.services[0].resource,
      "https://x402.agentutility.ai/wallet-label",
    );
    assertEquals(plan.alternates.labels, undefined);
    assertEquals(plan.unresolvedCategories, []);
  }));

Deno.test("selectFromRegistry: category with only over-cap candidates is unresolved", () =>
  withDb(async () => {
    const a = entry(
      "lab-a",
      "labels",
      "https://taxpulse-phi.vercel.app/api/crypto/wallet-sleuth",
      0.54,
      ServiceStatus.PROBATION,
    );
    a.price_usdc = 1.5;
    const b = entry(
      "lab-b",
      "labels",
      "https://chain-analyzer.com/api/v1/x402/wallet/:address/cluster",
      0.25,
      ServiceStatus.PROBATION,
    );
    b.price_usdc = 2.5;

    const plan = await selectFromRegistry("0xabc", ["labels"], {
      loadRecipes: recipeLoaderMustNotRun,
      getActive: () => Promise.resolve([a, b]),
    });

    assertEquals(plan.services, []);
    assertEquals(plan.unresolvedCategories, ["labels"]);
  }));

Deno.test("selectFromRegistry: offline path does not apply the price cap filter", () =>
  withoutDb(async () => {
    // Regression guard: the price filter is scoped to the DB/production path, so
    // an over-cap recipe on the offline branch must still be selected (offline
    // recipes are a frozen replay fixture that must keep mirroring cassettes).
    const recipes: Record<string, CallRecipe> = {
      lab1: recipe(
        "lab1",
        "labels",
        "https://labels.example/lookup",
        0.15, // above the cap, but offline path must not filter
      ),
    };
    const plan = await selectFromRegistry("0xabc", ["labels"], {
      loadRecipes: () => Promise.resolve(recipes),
    });

    assertEquals(plan.services.length, 1);
    assertEquals(plan.services[0].resource, "https://labels.example/lookup");
  }));
