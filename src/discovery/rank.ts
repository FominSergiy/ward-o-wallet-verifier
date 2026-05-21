import type { Category } from "../agent/types.ts";
import { defaultLlm, type LlmClient } from "../agent/llm.ts";
import {
  RankedSelectionSchema,
  type DiscoveryCandidatesByCategory,
  type DiscoveryEntry,
  type RankedSelection,
  type RankedService,
} from "./types.ts";

const MAX_DESC_CHARS = 200;

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
      sections.push(
        `  [${idx}] resource: ${e.resource}`,
        `      description: ${(e.description ?? "").slice(0, MAX_DESC_CHARS)}`,
        `      priceUsdc: ${priceUsdcFor(e, network)}`,
        `      qualityScore: ${qualityFor(e) ?? "unknown"}`,
        `      scheme: ${schemeFor(e, network)}`,
      );
    });
    sections.push("");
  }

  return `
You are picking the single best x402 service per category for a wallet risk-verification run.

Selection criteria, in order of importance:
1. Higher qualityScore (l30DaysUniquePayers — proven, recently used) is strongly preferred.
2. Lower priceUsdc breaks ties between similar-quality entries.
3. The description must clearly match the category intent. If no candidate fits, omit that category.

Return one selection per category as { category, resourceIndex, rationale }. The rationale is one short sentence.

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
    selection = await llm.generateStructured(RankedSelectionSchema, prompt);
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
