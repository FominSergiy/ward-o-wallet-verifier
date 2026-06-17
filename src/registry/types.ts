export type { CallRecipe } from "../discovery/recipe.ts";

/** A row from service_registry with numeric types resolved. */
export interface RegistryEntry {
  id: string;
  /** Short hash from call_recipes.json, stored as source in the DB. */
  service_id: string;
  resource: string;
  category: string;
  price_usdc: number;
  status: string;
  score: number;
  last_vetted_at: Date | null;
}
