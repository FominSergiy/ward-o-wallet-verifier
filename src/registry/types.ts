export type { CallRecipe } from "../discovery/recipe.ts";
import type { ServiceStatus } from "../db/enums.ts";

/** A row from service_registry with numeric types resolved. */
export interface RegistryEntry {
  id: string;
  /** Short hash from call_recipes.json, stored as source in the DB. */
  service_id: string;
  resource: string;
  category: string;
  price_usdc: number;
  status: ServiceStatus;
  score: number;
  last_vetted_at: Date | null;
  // Call shape (W0.11) — how to invoke this service. The DB is the single
  // source of truth in production; these mirror the new service_registry
  // columns. Null for legacy rows not yet backfilled (the invocation adapter
  // falls back to pattern defaults in that case).
  method: string | null;
  query_params: Record<string, unknown> | null;
  path_params: Record<string, unknown> | null;
  body_schema: unknown | null;
  body_type: string | null;
}
