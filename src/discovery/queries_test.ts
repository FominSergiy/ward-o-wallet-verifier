import { assertEquals, assertThrows } from "@std/assert";
import { CATEGORY_QUERIES, queriesForCategories } from "./queries.ts";
import type { Category } from "../agent/types.ts";

Deno.test("every non-ens category has a non-empty query", () => {
  const cats: Exclude<Category, "ens">[] = [
    "sanctions",
    "labels",
    "onchain_history",
    "web_sentiment",
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

Deno.test("labels query contains entity-attribution discovery terms", () => {
  const q = CATEGORY_QUERIES.labels.toLowerCase();
  // The terms that nudge discovery toward higher-coverage labelers — must all
  // be present so the candidate set isn't bottlenecked by the previous
  // narrower phrasing.
  for (const term of ["name tag", "hot wallet", "entity attribution"]) {
    assertEquals(q.includes(term), true, `labels query missing term: ${term}`);
  }
});

Deno.test("labels query preserves the original CEX/mixer terms", () => {
  const q = CATEGORY_QUERIES.labels.toLowerCase();
  for (const term of ["exchange", "cex", "mixer", "entity"]) {
    assertEquals(q.includes(term), true, `labels query lost prior term: ${term}`);
  }
});
