import { assertEquals } from "@std/assert";
import type { Call } from "./types.ts";
import { phaseGroups } from "./phases.ts";

function makeCall(category: Call["category"]): Call {
  return { category, provider: "x", endpoint: "x", estimatedCostUsdc: 0, phase: 1 };
}

Deno.test("phaseGroups splits into phase1 and phase2", () => {
  const calls = [makeCall("sanctions"), makeCall("onchain_history"), makeCall("labels")];
  const groups = phaseGroups(calls);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].map((c) => c.category).sort(), ["labels", "sanctions"]);
  assertEquals(groups[1].map((c) => c.category), ["onchain_history"]);
  assertEquals(groups[0][0].phase, 1);
  assertEquals(groups[1][0].phase, 2);
});

Deno.test("phaseGroups only ens -> one phase-2 group", () => {
  const groups = phaseGroups([makeCall("ens")]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0][0].phase, 2);
});

Deno.test("phaseGroups only sanctions -> one phase-1 group", () => {
  const groups = phaseGroups([makeCall("sanctions")]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0][0].phase, 1);
});

Deno.test("phaseGroups empty input -> empty result", () => {
  assertEquals(phaseGroups([]), []);
});

Deno.test("phaseGroups preserves order within phase", () => {
  const calls = [makeCall("labels"), makeCall("sanctions")];
  const groups = phaseGroups(calls);
  assertEquals(groups[0][0].category, "labels");
  assertEquals(groups[0][1].category, "sanctions");
});
