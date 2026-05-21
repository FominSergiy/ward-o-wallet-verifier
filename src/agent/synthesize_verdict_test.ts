import { assertEquals } from "@std/assert";
import { z } from "zod";
import { synthesizeVerdict } from "./synthesize_verdict.ts";
import type { SynthesisInput } from "./synthesize_verdict.ts";
import type { LlmClient } from "./llm.ts";
import type { WalletVerdict } from "./verdict.ts";

const ADDR = "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2";

function inputWith(args: {
  findings: SynthesisInput["findings"];
  resolved: SynthesisInput["coverage"]["resolved"];
  unresolved?: SynthesisInput["coverage"]["unresolved"];
}): SynthesisInput {
  return {
    address: ADDR,
    chain: "base",
    findings: args.findings,
    coverage: {
      requested: ["sanctions", "labels", "onchain_history"],
      resolved: args.resolved,
      unresolved: args.unresolved ?? [],
    },
    totalSpentUsdc: 0.01,
  };
}

function fixtureLlm(fixture: WalletVerdict, captured?: { model?: string; prompt?: string }): LlmClient {
  return {
    generateStructured<T>(
      schema: z.ZodType<T>,
      prompt: string,
      model?: string,
    ): Promise<T> {
      if (captured) {
        captured.model = model;
        captured.prompt = prompt;
      }
      return Promise.resolve(schema.parse(fixture));
    },
  };
}

const SAFE_VERDICT: WalletVerdict = {
  address: ADDR,
  chain: "base",
  safe: true,
  verdict: "safe_to_transact",
  confidence: "high",
  headline: "Wallet looks safe.",
  reasoning: "Clean sanctions; exchange label; long history.",
  findings: [
    { category: "sanctions", severity: "info", finding: "No sanctions hits." },
  ],
  coverage: { requested: [], resolved: [], unresolved: [] },
  totalSpentUsdc: 0.01,
  generatedAt: new Date().toISOString(),
};

const SANCTIONED_VERDICT: WalletVerdict = {
  ...SAFE_VERDICT,
  safe: false,
  verdict: "do_not_transact",
  confidence: "high",
  headline: "OFAC SDN hit.",
  reasoning: "Hard veto from sanctions match.",
  findings: [
    { category: "sanctions", severity: "critical", finding: "Matched OFAC SDN list." },
  ],
};

const INSUFFICIENT_VERDICT: WalletVerdict = {
  ...SAFE_VERDICT,
  safe: false,
  verdict: "insufficient_data",
  confidence: "low",
  headline: "Not enough signal.",
  reasoning: "Only ENS returned.",
  findings: [],
};

Deno.test("synthesizeVerdict passes Opus model id to llm.generateStructured", async () => {
  const captured: { model?: string; prompt?: string } = {};
  const llm = fixtureLlm(SAFE_VERDICT, captured);
  await synthesizeVerdict(
    inputWith({ findings: {}, resolved: [] }),
    { llm },
  );
  assertEquals(captured.model, "anthropic/claude-opus-4.7");
});

Deno.test("synthesizeVerdict honors model override via opts", async () => {
  const captured: { model?: string; prompt?: string } = {};
  const llm = fixtureLlm(SAFE_VERDICT, captured);
  await synthesizeVerdict(
    inputWith({ findings: {}, resolved: [] }),
    { llm, model: "anthropic/claude-haiku-4.5" },
  );
  assertEquals(captured.model, "anthropic/claude-haiku-4.5");
});

Deno.test("synthesizeVerdict prompt includes findings JSON and address", async () => {
  const captured: { model?: string; prompt?: string } = {};
  const llm = fixtureLlm(SAFE_VERDICT, captured);
  const findings = { sanctions: { sanctions_match: false } };
  await synthesizeVerdict(
    inputWith({ findings, resolved: ["sanctions"] }),
    { llm },
  );
  // Prompt should contain the address and the sanctions structure.
  assertEquals(captured.prompt?.includes(ADDR), true);
  assertEquals(captured.prompt?.includes("sanctions_match"), true);
});

Deno.test("synthesizeVerdict returns parsed WalletVerdict (sanctioned fixture)", async () => {
  const llm = fixtureLlm(SANCTIONED_VERDICT);
  const out = await synthesizeVerdict(
    inputWith({
      findings: { sanctions: { sanctions_match: true } },
      resolved: ["sanctions"],
    }),
    { llm },
  );
  assertEquals(out.safe, false);
  assertEquals(out.verdict, "do_not_transact");
  assertEquals(out.confidence, "high");
});

Deno.test("synthesizeVerdict returns insufficient_data when fixture says so", async () => {
  const llm = fixtureLlm(INSUFFICIENT_VERDICT);
  const out = await synthesizeVerdict(
    inputWith({
      findings: {},
      resolved: [],
      unresolved: ["sanctions", "labels", "onchain_history"],
    }),
    { llm },
  );
  assertEquals(out.verdict, "insufficient_data");
  assertEquals(out.confidence, "low");
});
