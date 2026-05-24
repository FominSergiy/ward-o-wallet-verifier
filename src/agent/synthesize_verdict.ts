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
   • If findings.sanctions indicates a match (any of: \`sanctions_match: true\`, non-empty \`sanctioned_lists\`, \`is_sanctioned: true\`, \`chainalysis_oracle.isSanctioned: true\`, or any wording confirming a hit) →
       safe = false, verdict = "do_not_transact", confidence = "high".
       Other signals MUST NOT override this.
   • If findings.sanctions includes \`chainalysis_oracle: { isSanctioned: false }\` → treat this as STRONG positive evidence: the on-chain Chainalysis oracle is sourced from OFAC SDN and is a high-trust deterministic signal. An oracle-clean result is sufficient to satisfy the "sanctions clean" requirement on its own, regardless of whether the x402 sanctions service also returned data.
   • If sanctions returned a clean check from an x402 service (no match) → also strong positive contribution.
   • If sanctions is in coverage.unresolved AND no oracle result is present → confidence drops to "low" at best; this is the single most important signal.

**2. labels — STRONG**
   • findings.labels may carry one of three shapes:
       - the raw x402 labeler payload (legacy single-source case), OR
       - \`{ x402_result, registry }\` when both the x402 labeler AND the eth-labels.com registry returned data, OR
       - \`{ registry }\` when only the registry returned data (x402 labeler was unresolved).
     Treat both sources as equally authoritative. The \`registry\` payload is a normalized list of \`{ address, label, nameTag, chainId }\` entries from a public mirror of Etherscan's label cloud — high-trust, deterministic attribution.
   • Words in returned labels signaling risk (scam, scammer, mixer, tumbler, darknet, phisher, phishing, hack, hacker, exploit, exploiter, rugpull, fraud, stolen) → bias verdict toward "do_not_transact". This includes \`registry.labels[].label\` values like \`blocked\`, \`ofac-sanctioned\`, \`ofac-sanctions-lists\`, \`tornado-cash\`, \`darknet\`, \`phishing\`, \`scam\`, \`hacker\`, \`exploiter\` — these are hard negative attribution and bias toward "do_not_transact" regardless of what the x402 labeler returned.
   • Words signaling safety (exchange, verified, protocol, dao, foundation, known_safe, attestation) → bias toward "safe_to_transact".
   • STRONG POSITIVE ATTRIBUTION: if \`findings.labels.registry.labels[]\` contains an entry whose \`label\` or \`nameTag\` matches a known CEX or major venue (\`coinbase\`, \`binance\`, \`kraken\`, \`bybit\`, \`okx\`, \`bitfinex\`, \`huobi\`, \`gemini\`, \`bitstamp\`, \`gate.io\`, \`upbit\`, \`exchange\`, \`fiat-gateway\`) or a known-safe protocol/foundation/DAO → treat as strong positive evidence, comparable to ENS-doxxed identity. When combined with sanctions-clean (oracle or x402), confidence MAY be "high" for "safe_to_transact" even if the x402 labeler returned empty.
   • Empty labels with no negative hits = neutral.

**3. onchain_history — SUPPORTING**
   • Long history (>1 year, >100 transactions) + non-zero balance → positive supporting evidence.
   • Brand-new wallet (<1 week, <5 transactions, near-zero balance) → suspicious/neutral; lowers overall confidence.
   • Patterns suggestive of mixer use (many small in-out roundtrips) → modest negative.

**4. web_sentiment — SUPPORTING**
   • Any web search hit referencing scam, exploit, hack, rugpull, lawsuit, indictment → flag as finding with severity "high" or "critical"; modest unsafe bias.
   • No relevant hits → neutral.

**5. ens — CONFIRMATORY**
   • findings.ens is the result of a free on-chain ENS reverse lookup. If \`ensName\` is a non-null string (e.g. "vitalik.eth"), the wallet is publicly doxxed to a real identity — this is STRONG positive evidence; clearly-doxxed wallets are very rarely actively malicious. Treat this as roughly equivalent to a known-safe label.
   • If ensName is null → neutral (most wallets don't have ENS; absence is not a negative).
   • COMBINATION RULE — when findings.ens.ensName is non-null AND sanctions are clean (oracle or x402) AND there is any positive onchain_history evidence (non-zero balance OR txCount > 0), you SHOULD return verdict="safe_to_transact" with at least confidence="medium" even if labels were empty/unresolved. The "insufficient_data" verdict is reserved for genuinely unknowable cases — ENS-doxxed + sanctions-clean is not unknowable.

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
