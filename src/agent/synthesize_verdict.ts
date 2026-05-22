import { defaultLlm, type LlmClient } from "./llm.ts";
import { WalletVerdictSchema, type WalletVerdict } from "./verdict.ts";
import type { Chain } from "../dag/types.ts";
import type { Category } from "./types.ts";
import type { Findings } from "./invoke_all.ts";

const OPUS_MODEL = Deno.env.get("SYNTHESIS_MODEL") ?? "anthropic/claude-opus-4.7";

export interface SynthesisInput {
  address: string;
  chain: Chain;
  findings: Findings;
  coverage: {
    requested: Category[];
    resolved: Category[];
    unresolved: Category[];
  };
  totalSpentUsdc: number;
}

const PROMPT_PREAMBLE = `
You are the final judgment layer of a wallet risk-verification agent. You will receive a JSON object with on-chain and off-chain signals about a single EVM wallet address. Your job is to decide whether it is safe for a user to SEND MONEY to this wallet, and produce a single \`WalletVerdict\` JSON object.

You MUST follow these per-signal weighting rules in order:

**1. sanctions — HARD VETO**
   • If findings.sanctions indicates a match (any of: \`sanctions_match: true\`, non-empty \`sanctioned_lists\`, \`is_sanctioned: true\`, or any wording confirming a hit) →
       safe = false, verdict = "do_not_transact", confidence = "high".
       Other signals MUST NOT override this.
   • If sanctions returned a clean check (no match) → strong positive contribution.
   • If sanctions is in coverage.unresolved → confidence drops to "low" at best; this is the single most important signal.

**2. labels — STRONG**
   • Words in returned labels signaling risk (scam, scammer, mixer, tumbler, darknet, phisher, phishing, hack, hacker, exploit, exploiter, rugpull, fraud, stolen) → bias verdict toward "do_not_transact".
   • Words signaling safety (exchange, verified, protocol, dao, foundation, known_safe, attestation) → bias toward "safe_to_transact".
   • Empty labels with no negative hits = neutral.

**3. onchain_history — SUPPORTING**
   • Long history (>1 year, >100 transactions) + non-zero balance → positive supporting evidence.
   • Brand-new wallet (<1 week, <5 transactions, near-zero balance) → suspicious/neutral; lowers overall confidence.
   • Patterns suggestive of mixer use (many small in-out roundtrips) → modest negative.

**4. web_sentiment — SUPPORTING**
   • Any web search hit referencing scam, exploit, hack, rugpull, lawsuit, indictment → flag as finding with severity "high" or "critical"; modest unsafe bias.
   • No relevant hits → neutral.

**5. contract_analysis — CONDITIONAL**
   • Only meaningful if the address is a contract. Vulnerabilities reported → unsafe. Clean audit → positive.
   • Empty or N/A for EOA → ignore.

**6. ens — CONFIRMATORY**
   • Confirmed ENS reverse lookup → minor positive (suggests a real, doxxed entity).
   • Absence → neutral.

**Confidence rules:**
   • "high" — sanctions hit; OR 3+ supporting categories with consistent signals.
   • "medium" — 3+ categories returned signals, mixed but interpretable.
   • "low" — ≤2 categories returned usable signals, OR all signals weak/inconclusive.

**Verdict mapping:**
   • "safe_to_transact" — safe=true. No critical signals; sanctions clean; at least one positive (label/onchain) signal; no strong negative labels.
   • "do_not_transact" — safe=false. Sanctions hit, OR clear negative labels, OR contract vulnerabilities, OR coverage explicitly says sanctions failed AND any other risk signal is present.
   • "insufficient_data" — safe=false. Fewer than 2 categories returned usable findings, OR sanctions in unresolved without any compensating high-confidence positives.

**Output requirements:**
   • The \`findings\` array should contain ONE entry per category that contributed evidence (positive or negative), with a short human-readable \`finding\` string.
   • \`headline\` is one sentence a non-technical user can read; lead with the verdict.
   • \`reasoning\` is 2–4 sentences explaining how you weighed the signals.
   • \`generatedAt\` is the current ISO 8601 timestamp.
   • \`coverage\`, \`address\`, \`chain\`, \`totalSpentUsdc\` are echoed from the input.

Return ONLY the structured object that matches the schema.
`.trim();

// Findings from upstream services can be large (labels returns entity lists,
// web_sentiment returns multi-page search hits). Cap per-category to keep the
// prompt within Opus's working size — empirically large prompts trigger
// "internal_error" upstream.
const MAX_FINDING_CHARS = 3000;

function truncateFindings(findings: Findings): Findings {
  const out: Findings = {};
  for (const [k, v] of Object.entries(findings)) {
    const stringified = JSON.stringify(v);
    if (stringified.length <= MAX_FINDING_CHARS) {
      out[k as keyof Findings] = v;
    } else {
      out[k as keyof Findings] = {
        __truncated: true,
        __originalSize: stringified.length,
        preview: stringified.slice(0, MAX_FINDING_CHARS) + "…[truncated]",
      };
    }
  }
  return out;
}

export async function synthesizeVerdict(
  input: SynthesisInput,
  opts: { llm?: LlmClient; model?: string } = {},
): Promise<WalletVerdict> {
  const llm = opts.llm ?? defaultLlm;
  const model = opts.model ?? OPUS_MODEL;

  const safeInput = { ...input, findings: truncateFindings(input.findings) };

  const prompt = `${PROMPT_PREAMBLE}

Input:
${JSON.stringify(safeInput, null, 2)}

The current ISO 8601 timestamp to use for generatedAt is: ${new Date().toISOString()}
`.trim();

  return await llm.generateStructured(WalletVerdictSchema, prompt, model);
}
