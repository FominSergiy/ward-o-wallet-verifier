import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { mockLlm } from "./llm.ts";

const FixtureSchema = z.object({
  categories: z.array(z.string()),
  rationale: z.string(),
}).describe("Plan");

Deno.test("mockLlm returns fixture matched by schema description", async () => {
  const fixture = {
    categories: ["sanctions", "labels"],
    rationale: "smoke test",
  };
  const llm = mockLlm({ Plan: fixture });
  const result = await llm.generateStructured(FixtureSchema, "ignored");
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
    Plan: { categories: [], rationale: "" },
  });
  await assertRejects(() =>
    llm.generateStructured(
      FixtureSchema.extend({ minLen: z.array(z.string()).min(1) }),
      "ignored",
    )
  );
});
