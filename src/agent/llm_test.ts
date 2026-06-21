import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { type LlmClient, mockLlm, withCostTracking } from "./llm.ts";
import type { GenerateStructuredOpts } from "../gateway.ts";

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

// --- withCostTracking ---------------------------------------------------------

// An LlmClient stub that drives onCost like the real gateway would, and records
// the opts it received so we can assert pass-through.
function costEmittingLlm(
  costsPerCall: number[],
  seen: { opts: GenerateStructuredOpts | string | undefined }[],
): LlmClient {
  let i = 0;
  return {
    generateStructured<T>(
      schema: z.ZodType<T>,
      _prompt: string,
      optsOrModel?: GenerateStructuredOpts | string,
    ): Promise<T> {
      seen.push({ opts: optsOrModel });
      const cost = costsPerCall[i++];
      if (typeof optsOrModel === "object" && optsOrModel?.onCost) {
        optsOrModel.onCost(cost);
      }
      return Promise.resolve(
        schema.parse({ categories: ["x"], rationale: "y" }),
      );
    },
  };
}

Deno.test("withCostTracking accumulates cost across calls into the sink", async () => {
  const sink = { totalUsd: 0 };
  const seen: { opts: GenerateStructuredOpts | string | undefined }[] = [];
  const tracked = withCostTracking(
    costEmittingLlm([0.001, 0.0025], seen),
    sink,
  );

  await tracked.generateStructured(FixtureSchema, "p1");
  await tracked.generateStructured(FixtureSchema, "p2");

  assertEquals(Math.round(sink.totalUsd * 1e6) / 1e6, 0.0035);
});

Deno.test("withCostTracking preserves a model-string arg as opts.model", async () => {
  const sink = { totalUsd: 0 };
  const seen: { opts: GenerateStructuredOpts | string | undefined }[] = [];
  const tracked = withCostTracking(costEmittingLlm([0.001], seen), sink);

  await tracked.generateStructured(FixtureSchema, "p", "anthropic/some-model");

  const opts = seen[0].opts as GenerateStructuredOpts;
  assertEquals(opts.model, "anthropic/some-model");
});

Deno.test("withCostTracking chains a caller-supplied onCost", async () => {
  const sink = { totalUsd: 0 };
  const seen: { opts: GenerateStructuredOpts | string | undefined }[] = [];
  const tracked = withCostTracking(costEmittingLlm([0.002], seen), sink);
  const callerSaw: number[] = [];

  await tracked.generateStructured(FixtureSchema, "p", {
    onCost: (usd) => callerSaw.push(usd),
  });

  assertEquals(callerSaw, [0.002]);
  assertEquals(sink.totalUsd, 0.002);
});
