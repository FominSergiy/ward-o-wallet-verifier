import { assertEquals } from "@std/assert";
import { buildDeterministicSources } from "./deterministic_sources.ts";
import type { Category } from "../agent/types.ts";

Deno.test("buildDeterministicSources always includes Chainalysis oracle", () => {
  const out = buildDeterministicSources([], "base");
  assertEquals(out.length, 1);
  assertEquals(out[0].category, "sanctions");
  assertEquals(out[0].gated, false);
  assertEquals(out[0].resource.includes("Chainalysis"), true);
});

Deno.test("buildDeterministicSources adds eth-labels when labels category requested", () => {
  const out = buildDeterministicSources(["labels"] as Category[], "base");
  assertEquals(out.length, 2);
  const labels = out.find((s) => s.category === "labels");
  assertEquals(labels !== undefined, true);
  assertEquals(labels!.gated, true);
  assertEquals(labels!.resource.includes("eth-labels.com"), true);
});

Deno.test("buildDeterministicSources adds ENS when ens category requested", () => {
  const out = buildDeterministicSources(["ens"] as Category[], "base");
  assertEquals(out.length, 2);
  const ens = out.find((s) => s.category === "ens");
  assertEquals(ens !== undefined, true);
  assertEquals(ens!.gated, true);
  assertEquals(ens!.resource.includes("ENS"), true);
});

Deno.test("buildDeterministicSources full default returns all three sources in stable order", () => {
  const cats: Category[] = [
    "sanctions",
    "labels",
    "onchain_history",
    "web_sentiment",
    "ens",
  ];
  const out = buildDeterministicSources(cats, "base");
  assertEquals(out.length, 3);
  // Order is stable: sanctions first (always), then labels, then ens.
  assertEquals(out.map((s) => s.category), ["sanctions", "labels", "ens"]);
});

Deno.test("buildDeterministicSources omits gated sources when category absent", () => {
  const out = buildDeterministicSources(
    ["sanctions", "onchain_history"] as Category[],
    "base",
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].category, "sanctions");
});
