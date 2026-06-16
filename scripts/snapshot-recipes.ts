// Snapshot current call recipes to data/call_recipes.json.
// Runs discover() once per target category against a known wallet address,
// captures each resolved service's parameter shape, and writes the result.
//
// Usage: ~/.deno/bin/deno run --allow-net --allow-env --allow-write scripts/snapshot-recipes.ts

import { discover } from "../src/discovery/discover.ts";
import type { Category } from "../src/agent/types.ts";
import {
  type CallRecipe,
  CallRecipeSchema,
  recipeId,
} from "../src/discovery/recipe.ts";

const TARGET_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
];

// A well-known non-empty wallet used only to drive discovery (not invoked).
const PROBE_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth

const OUTPUT_PATH = "data/call_recipes.json";

async function main() {
  console.log(
    `[snapshot-recipes] discovering for ${TARGET_CATEGORIES.join(", ")} …`,
  );

  const plan = await discover(PROBE_ADDRESS, TARGET_CATEGORIES, {
    limit: 5,
    maxUsdPrice: 1.0,
  });

  const recipes: Record<string, CallRecipe> = {};

  for (const svc of plan.services) {
    const info = svc.inputInfo;
    const id = recipeId(svc.resource, svc.payTo, svc.network);

    const recipe: CallRecipe = CallRecipeSchema.parse({
      service_id: id,
      category: svc.category,
      resource: svc.resource,
      method: (info?.method?.toUpperCase() === "GET" ? "GET" : "POST") as
        | "GET"
        | "POST",
      path_params: info?.pathParams ?? undefined,
      query_params: info?.queryParams ?? undefined,
      body_schema: info?.body ?? undefined,
      body_type: info?.bodyType ?? undefined,
      pay_to: svc.payTo,
      network: svc.network,
      price_usdc: svc.priceUsdc,
      snapshotted_at: new Date().toISOString(),
    });

    recipes[id] = recipe;
    console.log(
      `  [${svc.category}] ${svc.resource} → ${id} ($${
        svc.priceUsdc.toFixed(4)
      })`,
    );
  }

  const missing = TARGET_CATEGORIES.filter(
    (c) => !plan.services.some((s) => s.category === c),
  );
  if (missing.length > 0) {
    console.warn(
      `[snapshot-recipes] WARNING: no service resolved for: ${
        missing.join(", ")
      }`,
    );
  }

  const json = JSON.stringify(recipes, null, 2);
  await Deno.writeTextFile(OUTPUT_PATH, json);
  console.log(
    `[snapshot-recipes] wrote ${
      Object.keys(recipes).length
    } recipe(s) to ${OUTPUT_PATH}`,
  );
}

main().catch((e) => {
  console.error("[snapshot-recipes] fatal:", e);
  Deno.exit(1);
});
