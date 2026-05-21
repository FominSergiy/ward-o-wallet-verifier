import { assertEquals, assertThrows } from "@std/assert";
import { CATEGORY_QUERIES, queriesForCategories } from "./queries.ts";
import type { Category } from "../agent/types.ts";

Deno.test("every non-ens category has a non-empty query", () => {
  const cats: Exclude<Category, "ens">[] = [
    "sanctions",
    "labels",
    "onchain_history",
    "web_sentiment",
    "contract_analysis",
  ];
  for (const c of cats) {
    const q = CATEGORY_QUERIES[c];
    assertEquals(typeof q === "string" && q.length > 0, true, `missing query for ${c}`);
  }
});

Deno.test("queriesForCategories drops ens", () => {
  const out = queriesForCategories(["sanctions", "ens", "labels"]);
  assertEquals(Object.keys(out).length, 2);
  assertEquals("ens" in out, false);
  assertEquals(typeof out.sanctions, "string");
  assertEquals(typeof out.labels, "string");
});

Deno.test("queriesForCategories preserves order", () => {
  const out = queriesForCategories(["labels", "sanctions"]);
  assertEquals(Object.keys(out), ["labels", "sanctions"]);
});

Deno.test("queriesForCategories throws on unknown category", () => {
  assertThrows(
    () => queriesForCategories(["bogus" as Category]),
    Error,
    "Unknown category",
  );
});

Deno.test("queriesForCategories returns empty for empty input", () => {
  assertEquals(queriesForCategories([]), {});
});

Deno.test("queriesForCategories returns empty when only ens", () => {
  assertEquals(queriesForCategories(["ens"]), {});
});
