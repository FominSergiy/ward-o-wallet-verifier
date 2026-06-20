import { assertEquals } from "@std/assert";
import { z } from "zod";
import {
  selectSynthesisModel,
  synthesizeVerdict,
} from "./synthesize_verdict.ts";
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
  captured?: {
    model?: string;
    prompt?: string;
    toolName?: string;
    hasExample?: boolean;
  },
): LlmClient {
  return {
    generateStructured<T>(
      schema: z.ZodType<T>,
      prompt: string,
      optsOrModel?:
        | { model?: string; toolName?: string; toolExample?: unknown }
        | string,
    ): Promise<T> {
      const opts = typeof optsOrModel === "string"
        ? { model: optsOrModel }
        : optsOrModel ?? {};
      if (captured) {
        captured.model = opts.model;
        captured.toolName = opts.toolName;
        captured.hasExample =
          (opts as { toolExample?: unknown }).toolExample !== undefined;
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
    {
      category: "sanctions",
      severity: "critical",
      finding: "Matched OFAC SDN list.",
    },
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
  const captured: {
    model?: string;
    prompt?: string;
    toolName?: string;
    hasExample?: boolean;
  } = {};
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
  const captured: {
    model?: string;
    prompt?: string;
    toolName?: string;
    hasExample?: boolean;
  } = {};
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

Deno.test("cex_registry_attribution_serialized_into_prompt", async () => {
  const captured: { model?: string; prompt?: string } = {};
  const llm = fixtureLlm(SAFE_VERDICT, captured);
  const findings = {
    sanctions: { chainalysis_oracle: { isSanctioned: false } },
    labels: {
      registry: {
        source: "eth_labels_registry",
        endpoint:
          "https://eth-labels.com/labels/0x71660c4005BA85c37ccec55d0C4493E66Fe775d3",
        labels: [
          { label: "coinbase", nameTag: "Coinbase 1", chainId: 1 },
          { label: "fiat-gateway", nameTag: "Coinbase 1", chainId: 1 },
        ],
      },
    },
  };
  await synthesizeVerdict(
    inputWith({ findings, resolved: ["sanctions", "labels"] }),
    { llm },
  );
  // Prompt must carry both the registry shape marker and the CEX attribution text.
  assertEquals(captured.prompt?.includes("registry"), true);
  assertEquals(captured.prompt?.includes("coinbase"), true);
  assertEquals(captured.prompt?.includes("Coinbase 1"), true);
});

Deno.test("registry_negative_label_serialized_into_prompt", async () => {
  const captured: { model?: string; prompt?: string } = {};
  const llm = fixtureLlm(SANCTIONED_VERDICT, captured);
  const findings = {
    sanctions: { sanctions_match: false },
    labels: {
      x402_result: { tags: [] },
      registry: {
        source: "eth_labels_registry",
        labels: [
          { label: "blocked", nameTag: "OFAC Blocked", chainId: 1 },
          { label: "ofac-sanctions-lists", nameTag: null, chainId: 1 },
        ],
      },
    },
  };
  await synthesizeVerdict(
    inputWith({ findings, resolved: ["sanctions", "labels"] }),
    { llm },
  );
  // The merged shape and the negative labels must both appear so the policy can act on them.
  assertEquals(captured.prompt?.includes("x402_result"), true);
  assertEquals(captured.prompt?.includes("registry"), true);
  assertEquals(captured.prompt?.includes("blocked"), true);
  assertEquals(captured.prompt?.includes("ofac-sanctions-lists"), true);
});

Deno.test("prompt_documents_registry_rules_and_shape", async () => {
  const captured: { model?: string; prompt?: string } = {};
  const llm = fixtureLlm(SAFE_VERDICT, captured);
  await synthesizeVerdict(
    inputWith({
      findings: { sanctions: { sanctions_match: false } },
      resolved: ["sanctions"],
    }),
    { llm },
  );
  // The PREAMBLE must explain the three possible findings.labels shapes,
  // the CEX-attribution allow-list, and the registry-negative blocklist.
  const p = captured.prompt ?? "";
  assertEquals(p.includes("x402_result, registry"), true);
  assertEquals(p.includes("STRONG POSITIVE ATTRIBUTION"), true);
  assertEquals(p.includes("ofac-sanctioned"), true);
  assertEquals(p.includes("tornado-cash"), true);
  assertEquals(p.includes("fiat-gateway"), true);
});

// W0.6 model-routing tests

Deno.test("selectSynthesisModel: risk keyword in labels routes to Opus", () => {
  const input = inputWith({
    findings: {
      sanctions: { chainalysis_oracle: { isSanctioned: false } },
      labels: {
        registry: {
          labels: [{ label: "tornado-cash", nameTag: null, chainId: 1 }],
        },
      },
    },
    resolved: ["sanctions", "labels"],
  });
  assertEquals(selectSynthesisModel(input), "anthropic/claude-opus-4.7");
});

Deno.test("selectSynthesisModel: coverage below 50% routes to Opus", () => {
  // requested=3, resolved=1 → 1 < 3/2=1.5 → Opus
  const input = inputWith({
    findings: { sanctions: { sanctions_match: false } },
    resolved: ["sanctions"],
  });
  assertEquals(selectSynthesisModel(input), "anthropic/claude-opus-4.7");
});

Deno.test("selectSynthesisModel: clean CEX wallet uses Haiku", () => {
  const input = inputWith({
    findings: {
      sanctions: { chainalysis_oracle: { isSanctioned: false } },
      labels: {
        registry: {
          labels: [
            { label: "coinbase", nameTag: "Coinbase 1", chainId: 1 },
          ],
        },
      },
      onchain_history: { txCount: 5000, balance: "1.5" },
    },
    resolved: ["sanctions", "labels", "onchain_history"],
  });
  assertEquals(selectSynthesisModel(input), "anthropic/claude-haiku-4.5");
});

Deno.test("synthesizeVerdict: ambiguous (risk keyword) fixture routes to Opus", async () => {
  const captured: { model?: string } = {};
  const llm = fixtureLlm(SANCTIONED_VERDICT, captured);
  await synthesizeVerdict(
    inputWith({
      findings: {
        sanctions: { chainalysis_oracle: { isSanctioned: false } },
        labels: {
          registry: {
            labels: [{ label: "tornado-cash", nameTag: null, chainId: 1 }],
          },
        },
        onchain_history: { txCount: 100, balance: "0.0" },
      },
      resolved: ["sanctions", "labels", "onchain_history"],
    }),
    { llm },
  );
  assertEquals(captured.model, "anthropic/claude-opus-4.7");
});

Deno.test("synthesizeVerdict: clean-and-clean wallet uses Haiku", async () => {
  const captured: { model?: string } = {};
  const llm = fixtureLlm(SAFE_VERDICT, captured);
  await synthesizeVerdict(
    inputWith({
      findings: {
        sanctions: { chainalysis_oracle: { isSanctioned: false } },
        labels: {
          registry: {
            labels: [
              { label: "coinbase", nameTag: "Coinbase 1", chainId: 1 },
            ],
          },
        },
        onchain_history: { txCount: 5000, balance: "1.5" },
      },
      resolved: ["sanctions", "labels", "onchain_history"],
    }),
    { llm },
  );
  assertEquals(captured.model, "anthropic/claude-haiku-4.5");
});
