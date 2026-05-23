import { defaultLlm, type LlmClient } from "./llm.ts";
import { WalletVerdictSchema, type WalletVerdict } from "./verdict.ts";
import type { Category, Chain } from "./types.ts";
import type { Findings } from "./invoke_all.ts";

const OPUS_MODEL = Deno.env.get("SYNTHESIS_MODEL") ?? "anthropic/claude-opus-4.7";

// Placeholder values for the tool-call example. Opus produces more reliable
// structured output when shown a concrete schema-conforming example.
const VERDICT_EXAMPLE = {
  address: "0x0000000000000000000000000000000000000000",
  chain: "base",
  safe: true,
  verdict: "safe_to_transact",
  confidence: "high",
  headline:
    "Safe to transact — wallet has clean sanctions screen and verified exchange labels.",
  reasoning:
    "Sanctions check returned no matches. Address is labeled as a known exchange hot wallet, and on-chain history shows 2+ years of active use.",
  findings: [
    {
      category: "sanctions",
      severity: "info",
      finding: "No matches against OFAC SDN or other active sanctions lists.",
    },
  ],
  coverage: {
    requested: ["sanctions", "labels", "onchain_history"],
    resolved: ["sanctions", "labels", "onchain_history"],
    unresolved: [],
  },
  totalSpentUsdc: 0.011,
  generatedAt: "2026-05-22T12:00:00.000Z",
};

export interface SynthesisInput {
  address: string;
  chain: Chain;
  findings: Findings;
  coverage: {
    requested: Category[];
    resolved: Category[];
    unresolved: Category[];
    not_applicable?: Category[];
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
   • Words in returned labels signaling risk (scam, scammer, mixer, tumbler, darknet, phisher, phishing, hack, hacker, exploit, exploiter, rugpull, fraud, stolen, blocked, blacklist, malicious) → bias verdict toward "do_not_transact" with severity "high" or "critical".
   • Words signaling safety (exchange, verified, protocol, dao, foundation, known_safe, attestation) → count as a POSITIVE IDENTITY CONFIRMATION.
   • Empty labels with no negative hits = neutral — NOT a positive signal. The absence of a community phishing tag is not proof of safety; many phishing wallets are unlabeled in any single provider's database.

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
   • If a category appears in \`coverage.not_applicable\`, treat it as N/A (not a coverage gap) — do NOT mention it as "unresolved" or let it lower confidence.

**6. ens — CONFIRMATORY**
   • Confirmed ENS reverse lookup → minor positive (suggests a real, doxxed entity).
   • Absence → neutral.

**Positive identity confirmation (POIC) — REQUIRED for "safe_to_transact":**
A POIC is one of:
   • A positive \`labels\` finding containing exchange / verified / protocol / dao / foundation / known_safe / attestation / known-entity attribution.
   • A confirmed \`ens\` reverse-lookup resolving to a non-empty name.
   • A confirmed contract_analysis finding identifying the address as a clean, well-known protocol contract (e.g. Uniswap router, audited token).
A non-zero balance or a long transaction history is NOT a POIC — it indicates activity, not safety.

**Confidence rules:**
   • "high" — sanctions hit; OR sanctions clean + a POIC + 3+ supporting categories with consistent signals.
   • "medium" — sanctions clean + a POIC, with mixed but interpretable supporting signals.
   • "low" — ≤2 categories returned usable signals, OR no POIC present, OR all signals weak/inconclusive.

**Verdict mapping:**
   • "safe_to_transact" — safe=true. REQUIRES all of: sanctions clean, no negative labels, no critical findings, AND at least one POIC. If there is no POIC, you MUST NOT return "safe_to_transact" — return "insufficient_data" instead.
   • "do_not_transact" — safe=false. Sanctions hit, OR any negative label keyword present, OR contract vulnerabilities, OR coverage explicitly says sanctions failed AND any other risk signal is present.
   • "insufficient_data" — safe=false. Use whenever sanctions are clean but no POIC was returned (the common case for unlabeled wallets), OR fewer than 2 categories returned usable findings, OR sanctions in unresolved without any compensating high-confidence positives. The headline should make clear that absence of risk signals is NOT proof of safety.

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

  return await llm.generateStructured(WalletVerdictSchema, prompt, {
    model,
    toolName: "submit_wallet_verdict",
    toolDescription:
      "Submit the final WalletVerdict object for this wallet. The arguments " +
      "of THIS function call ARE the verdict — return all required fields " +
      "(address, chain, safe, verdict, confidence, headline, reasoning, " +
      "findings, coverage, totalSpentUsdc, generatedAt) at the top level.",
    toolExample: VERDICT_EXAMPLE,
  });
}
