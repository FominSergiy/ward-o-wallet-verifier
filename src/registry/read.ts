import { getDb } from "../db/client.ts";
import type { ServiceRegistryRow } from "../db/types.ts";
import { CallRecipeSchema } from "../discovery/recipe.ts";
import type { CallRecipe, RegistryEntry } from "./types.ts";

const RECIPES_PATH = new URL("../../data/call_recipes.json", import.meta.url);

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
  };
}

/**
 * Returns all active registry entries, optionally filtered by category.
 * Ordered by score desc, then insertion order.
 */
export async function getActiveServices(
  category?: string,
): Promise<RegistryEntry[]> {
  const db = getDb();
  const rows = category != null
    ? await db<ServiceRegistryRow[]>`
        SELECT * FROM service_registry
        WHERE status = 'active' AND category = ${category}
        ORDER BY score DESC, created_at ASC`
    : await db<ServiceRegistryRow[]>`
        SELECT * FROM service_registry
        WHERE status = 'active'
        ORDER BY score DESC, created_at ASC`;
  return rows.map(rowToEntry);
}

/**
 * Reads the full call recipe for a given service_id from call_recipes.json.
 * Throws if no matching entry is found.
 */
export async function getRecipe(service_id: string): Promise<CallRecipe> {
  const raw = await Deno.readTextFile(RECIPES_PATH);
  const all = JSON.parse(raw) as Record<string, unknown>;
  const entry = all[service_id];
  if (entry == null) {
    throw new Error(`no recipe found for service_id: ${service_id}`);
  }
  return CallRecipeSchema.parse(entry);
}
