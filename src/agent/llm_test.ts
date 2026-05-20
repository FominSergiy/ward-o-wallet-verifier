import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { mockLlm } from "./llm.ts";
import { PlanSchema } from "./types.ts";

Deno.test("mockLlm returns fixture matched by schema description", async () => {
  const fixture = {
    categories: ["sanctions", "labels"],
    rationale: "smoke test",
    earlyStop: {
      onSanctionHit: true,
      onConfirmedSafeLabel: true,
      budgetExhausted: true,
    },
  };
  const llm = mockLlm({ Plan: fixture });
  const result = await llm.generateStructured(PlanSchema, "ignored");
  assertEquals(result.categories, ["sanctions", "labels"]);
  assertEquals(result.rationale, "smoke test");
});

Deno.test("mockLlm falls back to first fixture when description does not match", async () => {
  const Anon = z.object({ value: z.number() });
  const llm = mockLlm({ FirstOnly: { value: 42 } });
  const result = await llm.generateStructured(Anon, "ignored");
  assertEquals(result.value, 42);
});

Deno.test("mockLlm throws when fixture violates schema", async () => {
  const llm = mockLlm({
    Plan: { categories: [], rationale: "", earlyStop: {} },
  });
  await assertRejects(() => llm.generateStructured(PlanSchema, "ignored"));
});
