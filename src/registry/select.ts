import type { Category } from "../agent/types.ts";
import type { LlmClient } from "../agent/llm.ts";
import { type EventEmitter, now, safeEmit } from "../agent/events.ts";
import type {
  DiscoveryPlan,
  RankedService,
  WalletNetwork,
} from "../discovery/types.ts";
import { buildDeterministicSources } from "../discovery/deterministic_sources.ts";
import { getDeniedHosts, isDeniedHost } from "../discovery/host_denylist.ts";
import { dbEnabled } from "../db/client.ts";
import { getActiveServices, loadAllRecipes, rowToRanked } from "./read.ts";
import type { CallRecipe } from "./types.ts";

/**
 * Thrown when production selection cannot read the service registry (the DB is
 * unreachable / the read errors). In production the active set MUST come from
 * the DB — we deliberately do NOT fall back to the checked-in recipe sample, so
 * the request fails loudly (mapped to a 503 `registry_unavailable`) instead of
 * silently serving a stale 4-service catalog.
 */
export class RegistryUnavailableError extends Error {
  constructor(cause: string) {
    super(`service registry unavailable: ${cause}`);
    this.name = "RegistryUnavailableError";
  }
}

// Recipes are snapshotted against Base mainnet (eip155:8453). The registry hot
// path is a pure read — we don't hit the Agnic /api/balance endpoint to detect
// the funded network (that call was part of the old discover() path we're
// replacing). Base is the only network the catalog serves today, so we pin it.
const DEFAULT_WALLET_NETWORK: WalletNetwork = "base";

export interface SelectFromRegistryOpts {
  // Accepted for call-signature parity with discover() at the verify call site
  // (verify passes { llm, onEvent, request_id }). selectFromRegistry does NOT
  // use the LLM — selection is a deterministic score-ordered read.
  llm?: LlmClient;
  walletNetwork?: WalletNetwork;
  onEvent?: EventEmitter;
  request_id?: string;
  // Test seams.
  getActive?: typeof getActiveServices;
  loadRecipes?: typeof loadAllRecipes;
}

// Translate a frozen call recipe into the RankedService shape the invocation
// phase consumes. This is the inverse of scripts/snapshot-recipes.ts, which
// built recipes FROM RankedService.inputInfo — so the round-trip reconstructs
// a call shape the pattern/LLM adapters already know how to drive. Used ONLY by
// the offline path (DATABASE_URL unset); production builds RankedServices from
// DB rows via rowToRanked().
function recipeToRanked(recipe: CallRecipe, score: number): RankedService {
  return {
    category: recipe.category,
    resource: recipe.resource,
    description: "",
    priceUsdc: recipe.price_usdc,
    network: recipe.network,
    payTo: recipe.pay_to,
    scheme: "exact",
    qualityScore: null,
    rationale: `Registry-selected (score=${score.toFixed(2)}).`,
    inputInfo: {
      method: recipe.method,
      queryParams: recipe.query_params,
      pathParams: recipe.path_params,
      body: recipe.body_schema,
      bodyType: recipe.body_type,
    },
  };
}

/**
 * The hot-path replacement for discover(): builds a DiscoveryPlan by reading
 * the curated service_registry instead of fanning out to Bazaar + LLM rerank.
 *
 * For each requested category it takes the selectable registry entries ordered
 * with `active` ahead of `probation`, then by score (descending), uses the top
 * one as the primary service and the rest as runtime fallback alternates. The
 * full call shape comes from the DB row's own columns (W0.11) — the DB is the
 * single source of truth.
 *
 * Branching (W0.11):
 *  - **DB enabled (production):** the active set comes ONLY from the DB. A read
 *    failure PROPAGATES as RegistryUnavailableError (→ 503) — we never silently
 *    serve the checked-in recipe sample as if it were live.
 *  - **DB disabled (offline / replay tests, DATABASE_URL unset):** every recipe
 *    in call_recipes.json is treated as active@1.0, so the offline gate works
 *    with no DB or network.
 */
export async function selectFromRegistry(
  address: string,
  categories: Category[],
  opts: SelectFromRegistryOpts = {},
): Promise<DiscoveryPlan> {
  const walletNetwork = opts.walletNetwork ?? DEFAULT_WALLET_NETWORK;
  const emit = opts.onEvent;
  const getActive = opts.getActive ?? getActiveServices;
  const loadRecipes = opts.loadRecipes ?? loadAllRecipes;

  // Build a per-category, rank-ordered list of selectable candidate services.
  const byCategory = new Map<Category, RankedService[]>();
  const push = (cat: Category, svc: RankedService) => {
    const list = byCategory.get(cat) ?? [];
    list.push(svc);
    byCategory.set(cat, list);
  };

  if (dbEnabled()) {
    // PRODUCTION: the DB is the single source of truth. Do NOT swallow a read
    // failure — let it surface as RegistryUnavailableError so the request fails
    // loudly (503) instead of degrading to the 4-entry recipe sample.
    let active;
    try {
      active = await getActive();
    } catch (e) {
      throw new RegistryUnavailableError((e as Error).message);
    }
    // Defense-in-depth against wholesale-dead providers (e.g. orbisapi.com):
    // even if a denied-host row survives as active/probation, never select it.
    // Scoped to the production DB path only — the offline recipe branch is a
    // frozen replay fixture that must keep mirroring the recorded cassettes.
    const deniedHosts = getDeniedHosts();
    // getActiveServices() already orders rows (active before probation, then
    // score desc), so iterating in order preserves ranking within a category.
    for (const entry of active) {
      // Defense-in-depth: blocked services must never be selected regardless of
      // what the getActive seam returns or how the DB query is shaped.
      if (entry.status === "blocked") continue;
      if (isDeniedHost(entry.resource, deniedHosts)) continue;
      push(entry.category as Category, rowToRanked(entry));
    }
  } else {
    // OFFLINE/TEST (DATABASE_URL unset): every recipe is treated as active@1.0.
    const recipesById = await loadRecipes();
    for (const recipe of Object.values(recipesById)) {
      push(recipe.category as Category, recipeToRanked(recipe, 1.0));
    }
  }

  const services: RankedService[] = [];
  const alternates: Partial<Record<Category, RankedService[]>> = {};
  const unresolvedCategories: Category[] = [];

  for (const cat of categories) {
    // ENS is a chain-primitive handled directly by verify; never a registry
    // x402 service — mirror discover()'s treatment of it.
    if (cat === "ens") continue;

    const candidates = byCategory.get(cat) ?? [];
    if (candidates.length === 0) {
      unresolvedCategories.push(cat);
      safeEmit(emit, {
        type: "log",
        level: "info",
        message: `registry_select: no active service for ${cat}`,
        at: now(),
      });
      continue;
    }

    const [primary, ...rest] = candidates;
    services.push(primary);
    if (rest.length > 0) {
      alternates[cat] = rest;
    }
    safeEmit(emit, {
      type: "log",
      level: "info",
      message:
        `registry_select: ${cat} → ${primary.resource} (${candidates.length} candidate${
          candidates.length === 1 ? "" : "s"
        })`,
      at: now(),
    });
  }

  const totalEstimatedCostUsdc = services.reduce((s, x) => s + x.priceUsdc, 0);

  return {
    address,
    walletNetwork,
    services,
    alternates,
    totalEstimatedCostUsdc,
    unresolvedCategories,
    deterministicSources: buildDeterministicSources(categories, walletNetwork),
    generatedAt: new Date().toISOString(),
  };
}
