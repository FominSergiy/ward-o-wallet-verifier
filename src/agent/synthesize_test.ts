import { assertEquals, assertRejects } from "@std/assert";
import type { AgentCtx } from "./types.ts";
import { mockLlm, type LlmClient } from "./llm.ts";
import { llmSynthesize } from "./synthesize.ts";

const VALID_REPORT = {
  address: "0x0000000000000000000000000000000000000000",
  chain: "eth",
  riskScore: 10,
  riskLabel: "low",
  sanctioned: false,
  labels: [],
  signals: [],
  summary: "Test fixture summary.",
  recommendation: "proceed",
  generatedAt: "2026-05-19T00:00:00.000Z",
};

function makeCtx(): AgentCtx {
  return {
    address: "0x0000000000000000000000000000000000000000",
    chain: "eth",
    spent: 0.001,
    receipts: [],
    findings: {},
  };
}

Deno.test("llmSynthesize returns valid RiskReport", async () => {
  const llm = mockLlm({ "": VALID_REPORT });
  const result = await llmSynthesize(makeCtx(), llm);
  assertEquals(result.riskScore, 10);
  assertEquals(result.recommendation, "proceed");
});

Deno.test("llmSynthesize rejects invalid fixture", async () => {
  const llm = mockLlm({ "": { ...VALID_REPORT, riskScore: 150 } });
  await assertRejects(() => llmSynthesize(makeCtx(), llm));
});

Deno.test("llmSynthesize prompt contains address and chain", async () => {
  let captured = "";
  const capturingLlm: LlmClient = {
    generateStructured<T>(_schema: unknown, prompt: string): Promise<T> {
      captured = prompt;
      return Promise.resolve(VALID_REPORT as T);
    },
  };
  await llmSynthesize(makeCtx(), capturingLlm);
  assertEquals(captured.includes("0x0000000000000000000000000000000000000000"), true);
  assertEquals(captured.includes("eth"), true);
});
