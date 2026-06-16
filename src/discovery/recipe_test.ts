import { assertEquals, assertGreater } from "@std/assert";
import { CallRecipeSchema, recipeId } from "./recipe.ts";
import type { Category } from "../agent/types.ts";

const RECIPES_PATH = "data/call_recipes.json";
const REQUIRED_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
];

Deno.test("call_recipes.json — has ≥1 entry per required category", async () => {
  const text = await Deno.readTextFile(RECIPES_PATH);
  const recipes = Object.values(JSON.parse(text)) as Array<
    { category: string }
  >;

  for (const cat of REQUIRED_CATEGORIES) {
    const found = recipes.some((r) => r.category === cat);
    assertEquals(found, true, `missing category: ${cat}`);
  }
});

Deno.test("call_recipes.json — every entry parses as CallRecipe", async () => {
  const text = await Deno.readTextFile(RECIPES_PATH);
  const entries = Object.entries(JSON.parse(text)) as Array<[string, unknown]>;

  assertGreater(entries.length, 0, "recipes file is empty");

  for (const [id, raw] of entries) {
    const result = CallRecipeSchema.safeParse(raw);
    assertEquals(
      result.success,
      true,
      `entry ${id} failed schema: ${
        JSON.stringify((result as { error?: unknown }).error)
      }`,
    );
  }
});

Deno.test("recipeId — produces distinct IDs for distinct resource URLs", () => {
  const payTo = "0xabc";
  const network = "eip155:8453";
  const id1 = recipeId("https://example.com/api/screen", payTo, network);
  const id2 = recipeId("https://example.com/api/labels", payTo, network);
  assertEquals(
    id1 === id2,
    false,
    "same host + different path should yield different IDs",
  );
});
