// Populates service_registry from data/call_recipes.json.
// All seeded entries get status='active', score=1.0, last_vetted_at=now().
// Safe to re-run: conflicts on resource URL are upserted.
//
//   DATABASE_URL=<neon-url> ~/.deno/bin/deno run --allow-net --allow-env --allow-read scripts/seed-registry.ts

import { getDb } from "../src/db/client.ts";
import { ServiceStatus } from "../src/db/enums.ts";
import { CallRecipeSchema } from "../src/discovery/recipe.ts";

const RECIPES_PATH = new URL("../data/call_recipes.json", import.meta.url);

const url = Deno.env.get("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL is required");
  Deno.exit(1);
}

const db = getDb();
const raw = await Deno.readTextFile(RECIPES_PATH);
const all = JSON.parse(raw) as Record<string, unknown>;

let count = 0;
for (const [service_id, entry] of Object.entries(all)) {
  const recipe = CallRecipeSchema.parse(entry);
  await db`
    INSERT INTO service_registry (resource, category, price_usdc, status, source, score, last_vetted_at)
    VALUES (
      ${recipe.resource},
      ${recipe.category},
      ${recipe.price_usdc},
      ${ServiceStatus.ACTIVE},
      ${service_id},
      1.0,
      now()
    )
    ON CONFLICT (resource) DO UPDATE SET
      category       = EXCLUDED.category,
      price_usdc     = EXCLUDED.price_usdc,
      status         = ${ServiceStatus.ACTIVE},
      source         = EXCLUDED.source,
      score          = EXCLUDED.score,
      last_vetted_at = now(),
      updated_at     = now()
  `;
  console.log(`seeded ${service_id} (${recipe.category}): ${recipe.resource}`);
  count++;
}

console.log(`done: ${count} entr${count === 1 ? "y" : "ies"} upserted`);
await db.end();
