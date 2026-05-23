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

function fixtureLlm(
  fixture: WalletVerdict,
  captured?: { model?: string; prompt?: string; toolName?: string; hasExample?: boolean },
): LlmClient {
  return {
    generateStructured<T>(
      schema: z.ZodType<T>,
      prompt: string,
      optsOrModel?: { model?: string; toolName?: string; toolExample?: unknown } | string,
    ): Promise<T> {
      const opts = typeof optsOrModel === "string"
        ? { model: optsOrModel }
        : optsOrModel ?? {};
      if (captured) {
        captured.model = opts.model;
        captured.toolName = opts.toolName;
        captured.hasExample = (opts as { toolExample?: unknown }).toolExample !== undefined;
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
  const captured: { model?: string; prompt?: string; toolName?: string; hasExample?: boolean } = {};
  const llm = fixtureLlm(SAFE_VERDICT, captured);
  await synthesizeVerdict(
    inputWith({ findings: {}, resolved: [] }),
    { llm },
  );
  assertEquals(captured.model, "anthropic/claude-opus-4.7");
  // Strict tool envelope: descriptive tool name + example payload included.
  assertEquals(captured.toolName, "submit_wallet_verdict");
  assertEquals(captured.hasExample, true);
});

Deno.test("synthesizeVerdict honors model override via opts", async () => {
  const captured: { model?: string; prompt?: string; toolName?: string; hasExample?: boolean } = {};
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

Deno.test("synthesizeVerdict prompt requires positive identity confirmation for safe verdict", async () => {
  const captured: { model?: string; prompt?: string } = {};
  const llm = fixtureLlm(SAFE_VERDICT, captured);
  await synthesizeVerdict(
    inputWith({ findings: {}, resolved: [] }),
    { llm },
  );
  const prompt = captured.prompt ?? "";
  // The policy MUST explicitly call out that absence of risk signals != safety,
  // and that a POIC (positive identity confirmation) is required for safe_to_transact.
  assertEquals(
    prompt.includes("Positive identity confirmation") || prompt.includes("POIC"),
    true,
    "prompt missing POIC requirement",
  );
  assertEquals(
    prompt.includes("not a POIC") || prompt.includes("NOT a POIC") ||
      prompt.includes("NOT a positive signal"),
    true,
    "prompt missing explicit non-POIC clarifier",
  );
  // Ensure the unlabeled-wallet escape hatch is wired up: insufficient_data
  // is the right verdict when no POIC is returned even if sanctions clean.
  assertEquals(prompt.includes("insufficient_data"), true);
  assertEquals(
    prompt.includes("MUST NOT return") || prompt.includes("must not return"),
    true,
    "prompt missing hard ban on safe_to_transact without POIC",
  );
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
