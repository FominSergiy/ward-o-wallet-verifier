import { getDb } from "../db/client.ts";
import type { ServiceRegistryRow } from "../db/types.ts";
import { CallRecipeSchema } from "../discovery/recipe.ts";
import type { Category } from "../agent/types.ts";
import type { RankedService } from "../discovery/types.ts";
import type { CallRecipe, RegistryEntry } from "./types.ts";

const RECIPES_PATH = new URL("../../data/call_recipes.json", import.meta.url);

// The registry catalog is snapshotted against Base mainnet. service_registry
// stores no per-row network/payTo (they're not needed to drive the call — the
// Agnic gateway settles payment from the upstream's own 402 response, and
// RankedService.payTo is informational only), so we pin Base here.
const REGISTRY_NETWORK = "eip155:8453";

function rowToEntry(row: ServiceRegistryRow): RegistryEntry {
  return {
    id: row.id,
    service_id: row.source ?? "",
    resource: row.resource,
    category: row.category,
    price_usdc: row.price_usdc != null ? parseFloat(row.price_usdc) : 0,
    status: row.status,
    score: parseFloat(row.score),
    last_vetted_at: row.last_vetted_at,
    method: row.method,
    query_params: row.query_params,
    path_params: row.path_params,
    body_schema: row.body_schema,
    body_type: row.body_type,
  };
}

/**
 * Builds the RankedService the invocation phase consumes directly from a
 * registry row's call-shape columns (W0.11) — the DB-as-single-source-of-truth
 * replacement for the old recipeToRanked() join against call_recipes.json.
 *
 * network is pinned (REGISTRY_NETWORK) and payTo is empty: neither is stored on
 * the row, and neither drives the actual HTTP call (see REGISTRY_NETWORK note).
 */
export function rowToRanked(entry: RegistryEntry): RankedService {
  return {
    category: entry.category as Category,
    resource: entry.resource,
    description: "",
    priceUsdc: entry.price_usdc,
    network: REGISTRY_NETWORK,
    payTo: "",
    scheme: "exact",
    qualityScore: null,
    rationale: `Registry-selected (status=${entry.status}, score=${
      entry.score.toFixed(2)
    }).`,
    inputInfo: {
      method: entry.method ?? undefined,
      queryParams: entry.query_params ?? undefined,
      pathParams: entry.path_params ?? undefined,
      body: entry.body_schema ?? undefined,
      bodyType: entry.body_type ?? undefined,
    },
  };
}

/**
 * Returns the selectable registry entries (status `active` OR `probation` —
 * `blocked` is excluded), optionally filtered by category, with their call
 * shapes. Ordered so `active` rows always outrank `probation` (the fallback
 * tier), then by score desc, then insertion order.
 *
 * probation is included so freshly discovered candidates receive real traffic
 * and can accumulate the observations needed to be promoted to active —
 * closing the W0.11 promotion deadlock.
 */
export async function getActiveServices(
  category?: string,
): Promise<RegistryEntry[]> {
  const db = getDb();
  const rows = category != null
    ? await db<ServiceRegistryRow[]>`
        SELECT * FROM service_registry
        WHERE status IN ('active', 'probation') AND category = ${category}
        ORDER BY (status = 'active') DESC, score DESC, created_at ASC`
    : await db<ServiceRegistryRow[]>`
        SELECT * FROM service_registry
        WHERE status IN ('active', 'probation')
        ORDER BY (status = 'active') DESC, score DESC, created_at ASC`;
  return rows.map(rowToEntry);
}

/**
 * Reads the full call recipe for a given service_id from call_recipes.json.
 * Throws if no matching entry is found.
 */
export async function getRecipe(service_id: string): Promise<CallRecipe> {
  const all = await loadAllRecipes();
  const entry = all[service_id];
  if (entry == null) {
    throw new Error(`no recipe found for service_id: ${service_id}`);
  }
  return entry;
}

/**
 * Loads and validates every recipe in call_recipes.json, keyed by service_id.
 * This is the offline source of call shapes used by selectFromRegistry — it
 * needs no DB or network, so the registry hot path (and replay tests) work
 * even when DATABASE_URL is unset.
 */
export async function loadAllRecipes(): Promise<Record<string, CallRecipe>> {
  const raw = await Deno.readTextFile(RECIPES_PATH);
  const all = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, CallRecipe> = {};
  for (const [id, entry] of Object.entries(all)) {
    out[id] = CallRecipeSchema.parse(entry);
  }
  return out;
}
