import { assertEquals } from "@std/assert";
import { isLikelyInvokableEndpoint, runVetter } from "./run.ts";
import type { CallShape } from "../discovery/types.ts";

// Shared no-op stubs for seams not under test.
const noopUpdatePrice = () => Promise.resolve();
const noopUpdateStatus = () => Promise.resolve();
const noopInsertCandidate = () => Promise.resolve(false);
const noopRewriteRecipe = () => Promise.resolve();
const emptyScoreResult = { updated: 0, transitions: [] };
const noopRecompute = () => Promise.resolve(emptyScoreResult);
const noopFetchCandidates = () =>
  Promise.resolve({
    walletNetwork: "base" as const,
    candidates: {},
    errors: {},
  });

// ── Discovery junk filter ─────────────────────────────────────────────────────

Deno.test("isLikelyInvokableEndpoint: rejects descriptor/meta URLs, keeps real endpoints", () => {
  // Real, invokable endpoints — including legit `:address` path params.
  assertEquals(
    isLikelyInvokableEndpoint("https://api.x402.com/v1/screen"),
    true,
  );
  assertEquals(
    isLikelyInvokableEndpoint(
      "https://orbisapi.com/proxy/wallet/balance/:address",
    ),
    true,
  );
  assertEquals(
    isLikelyInvokableEndpoint(
      "https://w.workers.dev/v1/wallet/cex_attribution",
    ),
    true,
  );
  // Provider-catalog meta-URLs that can never serve data.
  assertEquals(
    isLikelyInvokableEndpoint(
      "https://orbisapi.com/proxy/wallet-balance-api/wallet-balance/openapi.json",
    ),
    false,
  );
  assertEquals(
    isLikelyInvokableEndpoint(
      "https://orbisapi.com/proxy/wallet-api-5f3267/:endpoint",
    ),
    false,
  );
  assertEquals(
    isLikelyInvokableEndpoint("https://orbisapi.com/proxy/wallet-balance/info"),
    false,
  );
});

Deno.test(
  "runVetter: skips non-invokable discovered candidates (no dead probation rows)",
  async () => {
    const inserted: string[] = [];
    const result = await runVetter({
      fetchActiveAndProbation: () => Promise.resolve([]),
      probePrice: () => Promise.resolve({ maxAmountRequiredUsdc: null }),
      updatePrice: noopUpdatePrice,
      updateStatus: noopUpdateStatus,
      rewriteRecipePrice: noopRewriteRecipe,
      runRecomputeScores: noopRecompute,
      insertCandidate: (resource) => {
        inserted.push(resource);
        return Promise.resolve(true);
      },
      runFetchCandidates: () =>
        Promise.resolve({
          walletNetwork: "base" as const,
          candidates: {
            onchain_history: [
              {
                resource: "https://good.example/balance/:address",
                description: "balance",
                accepts: [{
                  scheme: "exact" as const,
                  network: "eip155:8453",
                  amount: "1000",
                  asset: "0xUSDC",
                  payTo: "0xABC",
                  maxTimeoutSeconds: 300,
                }],
              },
              {
                resource: "https://junk.example/wallet-api/:endpoint",
                description: "catch-all template",
                accepts: [{
                  scheme: "exact" as const,
                  network: "eip155:8453",
                  amount: "1000",
                  asset: "0xUSDC",
                  payTo: "0xABC",
                  maxTimeoutSeconds: 300,
                }],
              },
            ],
          },
          errors: {},
        }),
    });

    assertEquals(inserted, ["https://good.example/balance/:address"]);
    assertEquals(result.newCandidates, 1);
  },
);

// ── Test 0: discovered candidate is inserted WITH its call shape (W0.11) ──────
// The call shape must be snapshotted from the provider's bazaar input hints so
// the row is immediately invokable — no more "registry row with no recipe".

Deno.test(
  "runVetter: new candidate is inserted with the call shape from bazaar info",
  async () => {
    let captured: CallShape | null = null;

    await runVetter({
      fetchActiveAndProbation: () => Promise.resolve([]),
      probePrice: () => Promise.resolve({ maxAmountRequiredUsdc: null }),
      updatePrice: noopUpdatePrice,
      updateStatus: noopUpdateStatus,
      rewriteRecipePrice: noopRewriteRecipe,
      runRecomputeScores: noopRecompute,
      insertCandidate: (_resource, _category, _priceUsdc, _source, shape) => {
        captured = shape;
        return Promise.resolve(true);
      },
      runFetchCandidates: () =>
        Promise.resolve({
          walletNetwork: "base" as const,
          candidates: {
            onchain_history: [
              {
                resource:
                  "https://orbis.example/proxy/wallet-api/balance/:address",
                description: "Wallet balance",
                accepts: [
                  {
                    scheme: "exact" as const,
                    network: "eip155:8453",
                    amount: "5000",
                    asset: "0xUSDC",
                    payTo: "0xABC",
                    maxTimeoutSeconds: 300,
                  },
                ],
                extensions: {
                  bazaar: {
                    info: {
                      input: {
                        method: "GET",
                        pathParams: { address: "EVM wallet address" },
                        queryParams: {},
                      },
                    },
                  },
                },
              },
            ],
          },
          errors: {},
        }),
    });

    assertEquals(captured !== null, true);
    const shape = captured as unknown as CallShape;
    assertEquals(shape.method, "GET");
    assertEquals(shape.path_params, { address: "EVM wallet address" });
    assertEquals(shape.query_params, {});
    assertEquals(shape.body_schema, null);
    assertEquals(shape.body_type, null);
  },
);

// ── Test 1: new candidate from discovery is inserted as probation ─────────────

Deno.test(
  "runVetter: new candidate from discovery is inserted with probation status",
  async () => {
    const inserted: Array<{
      resource: string;
      category: string;
      priceUsdc: number;
    }> = [];

    const result = await runVetter({
      fetchActiveAndProbation: () => Promise.resolve([]),
      probePrice: () => Promise.resolve({ maxAmountRequiredUsdc: null }),
      updatePrice: noopUpdatePrice,
      updateStatus: noopUpdateStatus,
      rewriteRecipePrice: noopRewriteRecipe,
      runRecomputeScores: noopRecompute,
      insertCandidate: (resource, category, priceUsdc) => {
        inserted.push({ resource, category, priceUsdc });
        return Promise.resolve(true);
      },
      runFetchCandidates: () =>
        Promise.resolve({
          walletNetwork: "base" as const,
          candidates: {
            sanctions: [
              {
                resource: "https://new-service.example/screen",
                description: "OFAC sanctions screener",
                accepts: [
                  {
                    scheme: "exact" as const,
                    network: "eip155:8453",
                    amount: "1000",
                    asset: "0xUSDC",
                    payTo: "0xABC",
                    maxTimeoutSeconds: 300,
                  },
                ],
              },
            ],
          },
          errors: {},
        }),
    });

    assertEquals(inserted.length, 1);
    assertEquals(inserted[0].resource, "https://new-service.example/screen");
    assertEquals(inserted[0].category, "sanctions");
    assertEquals(inserted[0].priceUsdc, 0.001); // 1000 / 1_000_000
    assertEquals(result.newCandidates, 1);
  },
);

// ── Test 2: blocked services are not probed ────────────────────────────────────
// The vetter only fetches active/probation rows. Blocked rows never enter the
// probe loop, so probePrice should not be called for them.

Deno.test(
  "runVetter: blocked services are never probed (not returned by fetchActiveAndProbation)",
  async () => {
    const probedResources: string[] = [];

    await runVetter({
      // Only returns active/probation — blocked row is absent.
      fetchActiveAndProbation: () =>
        Promise.resolve([
          {
            resource: "https://active.example",
            price_usdc: "0.005",
            status: "active",
            source: "abc",
          },
          // blocked service intentionally omitted
        ]),
      probePrice: (resource) => {
        probedResources.push(resource);
        return Promise.resolve({ maxAmountRequiredUsdc: null });
      },
      updatePrice: noopUpdatePrice,
      updateStatus: noopUpdateStatus,
      rewriteRecipePrice: noopRewriteRecipe,
      runRecomputeScores: noopRecompute,
      insertCandidate: noopInsertCandidate,
      runFetchCandidates: noopFetchCandidates,
    });

    assertEquals(probedResources, ["https://active.example"]);
  },
);

// ── Test 3: price bump — real > stored, below ceiling ─────────────────────────
// maxAmountRequired=20000 → real=$0.020; stored=$0.005 → bumped=$0.024 (×1.20)

Deno.test(
  "runVetter: auto-bumps price when real > stored and real ≤ ceiling",
  async () => {
    const priceUpdates: Array<{ resource: string; priceUsdc: number }> = [];
    const recipeRewrites: Array<{
      serviceId: string | null;
      resource: string;
      newPrice: number;
    }> = [];

    const result = await runVetter({
      fetchActiveAndProbation: () =>
        Promise.resolve([
          {
            resource: "https://orbis.example/sentiment",
            price_usdc: "0.005",
            status: "active",
            source: "abc123",
          },
        ]),
      probePrice: () =>
        Promise.resolve({ maxAmountRequiredUsdc: 20_000 / 1_000_000 }), // $0.020
      updatePrice: (resource, priceUsdc) => {
        priceUpdates.push({ resource, priceUsdc });
        return Promise.resolve();
      },
      updateStatus: noopUpdateStatus,
      rewriteRecipePrice: (serviceId, resource, newPrice) => {
        recipeRewrites.push({ serviceId, resource, newPrice });
        return Promise.resolve();
      },
      runRecomputeScores: noopRecompute,
      insertCandidate: noopInsertCandidate,
      runFetchCandidates: noopFetchCandidates,
    });

    assertEquals(priceUpdates.length, 1);
    assertEquals(priceUpdates[0].resource, "https://orbis.example/sentiment");
    // 0.020 × 1.20 = 0.024
    assertEquals(priceUpdates[0].priceUsdc, 0.024);

    assertEquals(recipeRewrites.length, 1);
    assertEquals(recipeRewrites[0].serviceId, "abc123");
    assertEquals(recipeRewrites[0].resource, "https://orbis.example/sentiment");
    assertEquals(recipeRewrites[0].newPrice, 0.024);

    assertEquals(result.priceBumps.length, 1);
    assertEquals(result.priceBumps[0].oldPriceUsdc, 0.005);
    assertEquals(result.priceBumps[0].newPriceUsdc, 0.024);
  },
);

// ── Test 4: price above ceiling → probation, no auto-bump ─────────────────────

Deno.test(
  "runVetter: moves to probation when real price exceeds safety ceiling",
  async () => {
    const statusUpdates: Array<{ resource: string; status: string }> = [];
    const priceUpdates: Array<{ resource: string; priceUsdc: number }> = [];
    const recipeRewrites: string[] = [];

    const result = await runVetter({
      fetchActiveAndProbation: () =>
        Promise.resolve([
          {
            resource: "https://expensive.example/screen",
            price_usdc: "0.005",
            status: "active",
            source: "xyz789",
          },
        ]),
      probePrice: () =>
        Promise.resolve({ maxAmountRequiredUsdc: 110_000 / 1_000_000 }), // $0.110 > ceiling
      updatePrice: (resource, priceUsdc) => {
        priceUpdates.push({ resource, priceUsdc });
        return Promise.resolve();
      },
      updateStatus: (resource, status) => {
        statusUpdates.push({ resource, status });
        return Promise.resolve();
      },
      rewriteRecipePrice: (_, resource) => {
        recipeRewrites.push(resource);
        return Promise.resolve();
      },
      runRecomputeScores: noopRecompute,
      insertCandidate: noopInsertCandidate,
      runFetchCandidates: noopFetchCandidates,
    });

    assertEquals(statusUpdates.length, 1);
    assertEquals(statusUpdates[0].status, "probation");

    // price must NOT be auto-bumped
    assertEquals(priceUpdates.length, 0);
    // call_recipes.json must NOT be rewritten
    assertEquals(recipeRewrites.length, 0);

    assertEquals(result.probationMoves.length, 1);
    assertEquals(result.priceBumps.length, 0);
  },
);

// ── Test 5: stored price already covers real price → no-op ────────────────────

Deno.test(
  "runVetter: no update when stored price already covers maxAmountRequired",
  async () => {
    const priceUpdates: string[] = [];
    const statusUpdates: string[] = [];
    const recipeRewrites: string[] = [];

    const result = await runVetter({
      fetchActiveAndProbation: () =>
        Promise.resolve([
          {
            resource: "https://good.example/screen",
            price_usdc: "0.020",
            status: "active",
            source: "def456",
          },
        ]),
      probePrice: () =>
        Promise.resolve({ maxAmountRequiredUsdc: 15_000 / 1_000_000 }), // $0.015 < $0.020
      updatePrice: (resource) => {
        priceUpdates.push(resource);
        return Promise.resolve();
      },
      updateStatus: (resource) => {
        statusUpdates.push(resource);
        return Promise.resolve();
      },
      rewriteRecipePrice: (_, resource) => {
        recipeRewrites.push(resource);
        return Promise.resolve();
      },
      runRecomputeScores: noopRecompute,
      insertCandidate: noopInsertCandidate,
      runFetchCandidates: noopFetchCandidates,
    });

    assertEquals(priceUpdates.length, 0);
    assertEquals(statusUpdates.length, 0);
    assertEquals(recipeRewrites.length, 0);
    assertEquals(result.priceBumps.length, 0);
    assertEquals(result.probationMoves.length, 0);
  },
);

// ── Host denylist (A2) ──────────────────────────────────────────────────────
// Wholesale-dead providers (orbisapi.com de-x402'd its whole catalog) must
// never be re-seeded by discovery, or a DB block is undone on the next run.

function denyCandidates() {
  // Two discovered candidates in the same category: one on the denied host,
  // one on a live host. Both pass isLikelyInvokableEndpoint (real paths).
  return () =>
    Promise.resolve({
      walletNetwork: "base" as const,
      candidates: {
        sanctions: [
          {
            resource: "https://orbisapi.com/proxy/address-risk-api/screen",
            description: "dead orbis screener",
            accepts: [{
              scheme: "exact" as const,
              network: "eip155:8453",
              amount: "1000",
              asset: "0xUSDC",
              payTo: "0xABC",
              maxTimeoutSeconds: 300,
            }],
          },
          {
            resource: "https://api.anchor-x402.com/v1/screen",
            description: "live screener",
            accepts: [{
              scheme: "exact" as const,
              network: "eip155:8453",
              amount: "1000",
              asset: "0xUSDC",
              payTo: "0xABC",
              maxTimeoutSeconds: 300,
            }],
          },
        ],
      },
      errors: {},
    });
}

Deno.test("runVetter: skips candidates from a denied host", async () => {
  const prev = Deno.env.get("DISCOVERY_HOST_DENYLIST");
  Deno.env.delete("DISCOVERY_HOST_DENYLIST"); // use default (orbisapi.com)
  try {
    const inserted: string[] = [];
    const result = await runVetter({
      fetchActiveAndProbation: () => Promise.resolve([]),
      probePrice: () => Promise.resolve({ maxAmountRequiredUsdc: null }),
      updatePrice: noopUpdatePrice,
      updateStatus: noopUpdateStatus,
      rewriteRecipePrice: noopRewriteRecipe,
      runRecomputeScores: noopRecompute,
      insertCandidate: (resource) => {
        inserted.push(resource);
        return Promise.resolve(true);
      },
      runFetchCandidates: denyCandidates(),
    });
    // Only the live host was inserted; the orbis candidate was skipped.
    assertEquals(inserted, ["https://api.anchor-x402.com/v1/screen"]);
    assertEquals(result.newCandidates, 1);
  } finally {
    if (prev === undefined) Deno.env.delete("DISCOVERY_HOST_DENYLIST");
    else Deno.env.set("DISCOVERY_HOST_DENYLIST", prev);
  }
});

Deno.test("runVetter: DISCOVERY_HOST_DENYLIST env overrides the default host set", async () => {
  const prev = Deno.env.get("DISCOVERY_HOST_DENYLIST");
  // Override: deny the anchor host instead — now orbis is NOT denied.
  Deno.env.set("DISCOVERY_HOST_DENYLIST", "anchor-x402.com");
  try {
    const inserted: string[] = [];
    await runVetter({
      fetchActiveAndProbation: () => Promise.resolve([]),
      probePrice: () => Promise.resolve({ maxAmountRequiredUsdc: null }),
      updatePrice: noopUpdatePrice,
      updateStatus: noopUpdateStatus,
      rewriteRecipePrice: noopRewriteRecipe,
      runRecomputeScores: noopRecompute,
      insertCandidate: (resource) => {
        inserted.push(resource);
        return Promise.resolve(true);
      },
      runFetchCandidates: denyCandidates(),
    });
    // The override replaces the default: orbis inserted, anchor skipped.
    assertEquals(inserted, [
      "https://orbisapi.com/proxy/address-risk-api/screen",
    ]);
  } finally {
    if (prev === undefined) Deno.env.delete("DISCOVERY_HOST_DENYLIST");
    else Deno.env.set("DISCOVERY_HOST_DENYLIST", prev);
  }
});
