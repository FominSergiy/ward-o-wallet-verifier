import type { Category } from "../agent/types.ts";
import { defaultLlm, type LlmClient } from "../agent/llm.ts";
import { failureRate } from "./health_store.ts";
import {
  extractBazaarInfo,
  RankedSelectionSchema,
  type BazaarInfo,
  type DiscoveryCandidatesByCategory,
  type DiscoveryEntry,
  type RankedSelection,
  type RankedService,
} from "./types.ts";

const MAX_DESC_CHARS = 200;

// Score how completely a service has documented its input shape. Used as a
// secondary signal in the rerank prompt — services with rich `bazaar.info`
// almost always work with the pattern adapter; skeletal entries fall through
// to the LLM-fallback adapter and have a higher real-world error rate.
function inputInfoCompleteness(info: BazaarInfo | undefined): number {
  if (!info) return 0;
  let score = 0;
  if (info.method) score += 1;
  if (
    (info.queryParams && Object.keys(info.queryParams).length > 0) ||
    (info.pathParams && Object.keys(info.pathParams).length > 0)
  ) score += 1;
  if (info.body !== undefined) score += 1;
  return score; // 0..3
}

function priceUsdcFor(e: DiscoveryEntry, network: string): number {
  const a = e.accepts.find((x) => x.network === network) ?? e.accepts[0];
  return parseInt(a.amount, 10) / 1_000_000;
}

function payToFor(e: DiscoveryEntry, network: string): string {
  const a = e.accepts.find((x) => x.network === network) ?? e.accepts[0];
  return a.payTo;
}

function schemeFor(e: DiscoveryEntry, network: string): "exact" | "upto" {
  const a = e.accepts.find((x) => x.network === network) ?? e.accepts[0];
  return a.scheme;
}

function qualityFor(e: DiscoveryEntry): number | null {
  return e.extensions?.bazaar?.quality?.l30DaysUniquePayers ?? null;
}

function buildPrompt(
  candidates: Partial<Record<Category, DiscoveryEntry[]>>,
  network: string,
): string {
  const sections: string[] = [];
  for (const [cat, entries] of Object.entries(candidates) as [Category, DiscoveryEntry[]][]) {
    sections.push(`Category: ${cat}`);
    entries.forEach((e, idx) => {
      const fr = failureRate(e.resource);
      const frStr = fr === null
        ? "unknown (untested)"
        : `${(fr * 100).toFixed(0)}%`;
      const info = extractBazaarInfo(e);
      sections.push(
        `  [${idx}] resource: ${e.resource}`,
        `      description: ${(e.description ?? "").slice(0, MAX_DESC_CHARS)}`,
        `      priceUsdc: ${priceUsdcFor(e, network)}`,
        `      qualityScore: ${qualityFor(e) ?? "unknown"}`,
        `      recentFailureRate: ${frStr}`,
        `      inputInfoCompleteness: ${inputInfoCompleteness(info)}/3`,
        `      scheme: ${schemeFor(e, network)}`,
      );
    });
    sections.push("");
  }

  return `
You are picking the single best x402 service per category for a wallet risk-verification run.

Selection criteria, in priority order:
1. recentFailureRate is the STRONGEST signal. If a candidate has > 50% recent failure rate, skip it unless every other candidate also has high failure or unknown rate. Failure rate is observed real-world performance — descriptions and qualityScores cannot override it.
2. inputInfoCompleteness (0..3) — services that document their input shape fully (method + params + body) are far more likely to actually respond. Prefer 2 and 3.
3. Higher qualityScore (l30DaysUniquePayers — proven, recently used) is the next-best signal.
4. Lower priceUsdc breaks ties between similar-quality entries.
5. The description must clearly match the category intent. If no candidate fits, omit that category.

Return one selection per category as { category, resourceIndex, rationale }. The rationale is one short sentence that mentions which of the above signals drove the pick.

Candidates:
${sections.join("\n")}
`.trim();
}

function fallbackPick(entries: DiscoveryEntry[], network: string): number {
  // Highest l30DaysUniquePayers, tie-break by lowest price.
  let bestIdx = 0;
  let bestQuality = -1;
  let bestPrice = Number.POSITIVE_INFINITY;
  entries.forEach((e, i) => {
    const q = qualityFor(e) ?? 0;
    const p = priceUsdcFor(e, network);
    if (q > bestQuality || (q === bestQuality && p < bestPrice)) {
      bestIdx = i;
      bestQuality = q;
      bestPrice = p;
    }
  });
  return bestIdx;
}

function toRanked(
  cat: Category,
  entry: DiscoveryEntry,
  network: string,
  rationale: string,
): RankedService {
  return {
    category: cat,
    resource: entry.resource,
    description: entry.description ?? "",
    priceUsdc: priceUsdcFor(entry, network),
    network,
    payTo: payToFor(entry, network),
    scheme: schemeFor(entry, network),
    qualityScore: qualityFor(entry),
    rationale,
    inputInfo: extractBazaarInfo(entry),
  };
}

export async function rankServices(
  candidates: DiscoveryCandidatesByCategory,
  llm: LlmClient = defaultLlm,
): Promise<RankedService[]> {
  const network = candidates.walletNetwork === "base" ? "eip155:8453" : "eip155:84532";
  const entries = Object.entries(candidates.candidates) as [Category, DiscoveryEntry[]][];
  if (entries.length === 0) return [];

  let selection: RankedSelection | null = null;
  try {
    const prompt = buildPrompt(candidates.candidates, network);
    selection = await llm.generateStructured(RankedSelectionSchema, prompt, {
      toolName: "select_services",
      toolDescription:
        "Select one best x402 service per category by emitting a selections " +
        "array. Each entry: { category, resourceIndex, rationale }. Return " +
        "ALL fields at the top level of the function arguments — do NOT wrap " +
        "in any envelope.",
      toolExample: {
        selections: [
          {
            category: "sanctions",
            resourceIndex: 0,
            rationale: "Lowest price with broad OFAC SDN coverage.",
          },
        ],
      },
    });
  } catch (e) {
    console.warn("[rank] LLM rerank failed, falling back to quality-sort:", (e as Error).message);
  }

  const out: RankedService[] = [];

  if (selection) {
    for (const s of selection.selections) {
      const list = candidates.candidates[s.category];
      if (!list || s.resourceIndex < 0 || s.resourceIndex >= list.length) continue;
      out.push(toRanked(s.category, list[s.resourceIndex], network, s.rationale));
    }
  } else {
    for (const [cat, list] of entries) {
      const idx = fallbackPick(list, network);
      out.push(
        toRanked(
          cat,
          list[idx],
          network,
          "Fallback selection: highest usage, lowest price.",
        ),
      );
    }
  }

  return out;
}
