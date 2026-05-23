import { assertEquals, assertThrows } from "@std/assert";
import { CATEGORY_QUERIES, queriesForCategories } from "./queries.ts";
import type { Category } from "../agent/types.ts";

Deno.test("every non-ens category has at least one non-empty query", () => {
  const cats: Exclude<Category, "ens">[] = [
    "sanctions",
    "labels",
    "onchain_history",
    "web_sentiment",
    "contract_analysis",
  ];
  for (const c of cats) {
    const qs = CATEGORY_QUERIES[c];
    assertEquals(Array.isArray(qs), true, `query list for ${c} must be array`);
    assertEquals(qs.length >= 1, true, `${c} must have at least one query`);
    for (const q of qs) {
      assertEquals(typeof q === "string" && q.length > 0, true, `${c} has empty query`);
    }
  }
});

Deno.test("labels emits both attribution and phishing/scam queries", () => {
  const qs = CATEGORY_QUERIES.labels;
  assertEquals(qs.length >= 2, true, "labels must issue at least 2 queries");
  const joined = qs.join(" | ").toLowerCase();
  // Attribution / CEX clustering signal — original query family.
  assertEquals(joined.includes("exchange"), true, "missing attribution query");
  // Community phishing / scam blocklist signal — the gap-closure query.
  assertEquals(joined.includes("phishing"), true, "missing phishing query");
  assertEquals(joined.includes("scam"), true, "missing scam query");
});

Deno.test("queriesForCategories drops ens", () => {
  const out = queriesForCategories(["sanctions", "ens", "labels"]);
  assertEquals(Object.keys(out).length, 2);
  assertEquals("ens" in out, false);
  assertEquals(Array.isArray(out.sanctions), true);
  assertEquals(Array.isArray(out.labels), true);
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
