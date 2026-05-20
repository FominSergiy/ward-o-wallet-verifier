import { assertEquals } from "@std/assert";
import { mockLlm, type LlmClient } from "./llm.ts";
import { PlanSchema } from "./types.ts";
import { llmPlan } from "./plan.ts";

const FIXTURE = {
  categories: ["sanctions", "labels", "onchain_history"],
  rationale: "EOA on eth, no prior signal",
  earlyStop: { onSanctionHit: true, onConfirmedSafeLabel: true, budgetExhausted: true },
};

Deno.test("llmPlan returns valid Plan", async () => {
  const llm = mockLlm({ Plan: FIXTURE });
  const result = await llmPlan("0xABC", "eth", llm);
  PlanSchema.parse(result);
  assertEquals(result.categories.length > 0, true);
});

Deno.test("llmPlan categories have no duplicates", async () => {
  const llm = mockLlm({ Plan: FIXTURE });
  const result = await llmPlan("0xABC", "eth", llm);
  assertEquals(new Set(result.categories).size, result.categories.length);
});

Deno.test("llmPlan prompt contains address and chain", async () => {
  let captured = "";
  const capturingLlm: LlmClient = {
    generateStructured<T>(_schema: unknown, prompt: string): Promise<T> {
      captured = prompt;
      return Promise.resolve(FIXTURE as T);
    },
  };
  await llmPlan("0xDEADBEEF", "base", capturingLlm);
  assertEquals(captured.includes("0xDEADBEEF"), true);
  assertEquals(captured.includes("base"), true);
});
