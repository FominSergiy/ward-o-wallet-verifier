import type { Category } from "../agent/types.ts";
import type { LlmClient } from "../agent/llm.ts";
import { type EventEmitter, now, safeEmit } from "../agent/events.ts";
import type {
  DiscoveryPlan,
  RankedService,
  WalletNetwork,
} from "../discovery/types.ts";
import { buildDeterministicSources } from "../discovery/deterministic_sources.ts";
import { getActiveServices, loadAllRecipes } from "./read.ts";
import type { CallRecipe, RegistryEntry } from "./types.ts";

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

interface SelectedCandidate {
  recipe: CallRecipe;
  score: number;
}

// Translate a frozen call recipe into the RankedService shape the invocation
// phase consumes. This is the inverse of scripts/snapshot-recipes.ts, which
// built recipes FROM RankedService.inputInfo — so the round-trip reconstructs
// a call shape the pattern/LLM adapters already know how to drive.
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
 * For each requested category it takes the active registry entries ordered by
 * score (descending), uses the top one as the primary service and the rest as
 * runtime fallback alternates. The full call shape comes from
 * data/call_recipes.json, joined to the registry row by service_id.
 *
 * Offline-safe: when the DB is unset/unreachable (e.g. replay tests, local dev
 * without DATABASE_URL) getActiveServices() returns [], and we fall back to
 * treating every recipe in call_recipes.json as active at score 1.0 — the same
 * thing seed-registry.ts writes into the table.
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

  const recipesById = await loadRecipes();

  // Active registry rows give us the score ordering + which service_ids are
  // live. If the DB is down or empty, fall back to the recipe file as the
  // active set (score 1.0) so the hot path still works offline.
  let active: RegistryEntry[];
  try {
    active = await getActive();
  } catch (e) {
    console.warn(
      `[select] registry read failed (${
        (e as Error).message
      }) — falling back to call_recipes.json`,
    );
    active = [];
  }

  // Build a per-category, score-ordered list of selectable candidates.
  const byCategory = new Map<Category, SelectedCandidate[]>();
  const push = (cat: Category, recipe: CallRecipe, score: number) => {
    const list = byCategory.get(cat) ?? [];
    list.push({ recipe, score });
    byCategory.set(cat, list);
  };

  if (active.length > 0) {
    // getActiveServices() already returns rows ordered by score DESC, so
    // iterating in order preserves the ranking within each category.
    for (const entry of active) {
      // Explicit guard: blocked services must never be selected regardless of
      // what the caller's getActive seam returns or how the DB query is shaped.
      if (entry.status === "blocked") continue;
      const recipe = recipesById[entry.service_id];
      if (!recipe) {
        // Registry row references a service_id we have no call recipe for —
        // we can't invoke it, so skip. (W0.10's vetter is responsible for
        // keeping recipes and registry rows in sync.)
        console.warn(
          `[select] active registry entry ${entry.resource} (service_id=${entry.service_id}) has no call recipe — skipping`,
        );
        continue;
      }
      push(recipe.category as Category, recipe, entry.score);
    }
  } else {
    // Offline fallback: every recipe is treated as active@1.0.
    for (const recipe of Object.values(recipesById)) {
      push(recipe.category as Category, recipe, 1.0);
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
    services.push(recipeToRanked(primary.recipe, primary.score));
    if (rest.length > 0) {
      alternates[cat] = rest.map((c) => recipeToRanked(c.recipe, c.score));
    }
    safeEmit(emit, {
      type: "log",
      level: "info",
      message:
        `registry_select: ${cat} → ${primary.recipe.resource} (${candidates.length} candidate${
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
