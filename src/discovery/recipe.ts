import { z } from "zod";
import type { Category } from "../agent/types.ts";

// Stable identity for a service — hash of resource + payTo + network.
// Using the full resource URL (not just host) keeps distinct endpoints at the
// same provider (e.g. orbisapi.com serving labels vs onchain_history) unique.
export function recipeId(
  resource: string,
  payTo: string,
  network: string,
): string {
  const raw = `${resource}|${payTo}|${network}`;
  // Simple djb2-style hash expressed as hex — no crypto needed for a stable key.
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h) ^ raw.charCodeAt(i);
    h >>>= 0; // keep 32-bit unsigned
  }
  return h.toString(16).padStart(8, "0");
}

export const CallRecipeSchema = z.object({
  service_id: z.string(),
  category: z.string() as z.ZodType<Category>,
  resource: z.string().url(),
  method: z.enum(["GET", "POST"]),
  path_params: z.record(z.string(), z.unknown()).optional(),
  query_params: z.record(z.string(), z.unknown()).optional(),
  body_schema: z.unknown().optional(),
  body_type: z.string().optional(),
  pay_to: z.string(),
  network: z.string(),
  price_usdc: z.number(),
  snapshotted_at: z.string(),
});

export type CallRecipe = z.infer<typeof CallRecipeSchema>;
