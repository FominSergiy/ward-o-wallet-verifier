import type { Category } from "../agent/types.ts";
import { defaultLlm, type LlmClient } from "../agent/llm.ts";
import {
  failureRate,
  isDurablyBlocked,
  isQualityDemoted,
} from "./health_store.ts";
import {
  type BazaarInfo,
  type DiscoveryCandidatesByCategory,
  type DiscoveryEntry,
  extractBazaarInfo,
  type RankedSelection,
  RankedSelectionSchema,
  type RankedService,
} from "./types.ts";

const MAX_DESC_CHARS = 200;

// Description keywords that hint at strong entity-attribution coverage. Used
// as a soft signal in the rerank prompt for the `labels` category — services
// describing themselves with these terms get a small preference, all else
// equal. Operates on description text only — no provider IDs or URLs are
// hard-coded.
const ENTITY_ATTRIBUTION_KEYWORDS = [
  "entity attribution",
  "name tag",
  "hot wallet",
  "known address",
  "exchange identification",
  "cex labels",
  "address database",
  "cluster",
];

function describesEntityAttribution(description: string | undefined): boolean {
  if (!description) return false;
  const lower = description.toLowerCase();
  return ENTITY_ATTRIBUTION_KEYWORDS.some((k) => lower.includes(k));
}

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

// Extract the bare host (no port, no scheme) for cross-category diversity
// hints. Falls back to the original string when parsing fails — that yields a
// no-op hint, which is fine.
function hostOf(resource: string): string {
  try {
    return new URL(resource).hostname;
  } catch {
    return resource;
  }
}

// Compute the per-host coverage across all categories — used to surface a
// diversity hint when the same host shows up as a candidate for 2+ categories.
// The LLM rule below treats this as a soft tiebreaker; we never drop a
// candidate purely on host collision.
function buildHostCoverage(
  candidates: Partial<Record<Category, DiscoveryEntry[]>>,
): Map<string, Set<Category>> {
  const out = new Map<string, Set<Category>>();
  for (
    const [cat, entries] of Object.entries(candidates) as [
      Category,
      DiscoveryEntry[],
    ][]
  ) {
    for (const e of entries) {
      const h = hostOf(e.resource);
      const set = out.get(h) ?? new Set<Category>();
      set.add(cat);
      out.set(h, set);
    }
  }
  return out;
}

async function buildPrompt(
  candidates: Partial<Record<Category, DiscoveryEntry[]>>,
  network: string,
): Promise<string> {
  const sections: string[] = [];
  const hostCoverage = buildHostCoverage(candidates);
  for (
    const [cat, entries] of Object.entries(candidates) as [
      Category,
      DiscoveryEntry[],
    ][]
  ) {
    sections.push(`Category: ${cat}`);
    for (const [idx, e] of entries.entries()) {
      const fr = await failureRate(e.resource);
      const frStr = fr === null
        ? "unknown (untested)"
        : `${(fr * 100).toFixed(0)}%`;
      const info = extractBazaarInfo(e);
      const entityHint = cat === "labels" &&
          describesEntityAttribution(e.description)
        ? "  [hint: description mentions entity-attribution keywords]"
        : "";
      // Host-diversity hint: surfaces when the same host shows up as a
      // candidate in OTHER categories during this run. Lets the LLM apply
      // Rule 7 (prefer non-colliding hosts on ties) without us hard-coding
      // any vendor names.
      const host = hostOf(e.resource);
      const otherCats = [...(hostCoverage.get(host) ?? [])]
        .filter((c) => c !== cat);
      const hostHint = otherCats.length > 0
        ? `  [hint: host ${host} also appears in candidates for: ${
          otherCats.join(", ")
        }]`
        : "";
      sections.push(
        `  [${idx}] resource: ${e.resource}${entityHint}${hostHint}`,
        `      description: ${(e.description ?? "").slice(0, MAX_DESC_CHARS)}`,
        `      priceUsdc: ${priceUsdcFor(e, network)}`,
        `      qualityScore: ${qualityFor(e) ?? "unknown"}`,
        `      recentFailureRate: ${frStr}`,
        `      inputInfoCompleteness: ${inputInfoCompleteness(info)}/3`,
        `      scheme: ${schemeFor(e, network)}`,
      );
    }
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
6. For the \`labels\` category specifically: when two candidates are otherwise tied on the above criteria, prefer one whose description mentions entity attribution (look for hints like "entity attribution", "name tag", "hot wallet", "known address database", "cluster" — these correlate with better CEX/known-entity coverage). The pre-computed "[hint: …]" tag next to a resource line surfaces this; otherwise inspect the description directly. This is a SOFT preference — never override a stronger failure-rate / quality / completeness signal.
7. Host diversity: when a candidate's host already appears in candidate lists for OTHER categories (look for "[hint: host ... also appears in candidates for: ...]") AND another candidate in this category is otherwise tied on the above criteria, prefer the one whose host does NOT cross-appear. Vendor-agnostic catalogs occasionally have one provider winning every category by default; spreading across hosts reduces correlated-failure risk. SOFT preference only — failure-rate / quality / completeness always win.

Return one selection per category as { category, resourceIndex, rationale }. The rationale is one short sentence that mentions which of the above signals drove the pick.

Candidates:
${sections.join("\n")}
`.trim();
}

function fallbackPick(
  entries: DiscoveryEntry[],
  network: string,
  category: Category,
): number {
  // Highest l30DaysUniquePayers, tie-break by lowest price. For labels, prefer
  // entries whose description mentions entity-attribution keywords when scores
  // are tied — this is the only non-discovery-honest signal we use here, and
  // it operates purely on the catalog-provided text.
  let bestIdx = 0;
  let bestQuality = -1;
  let bestPrice = Number.POSITIVE_INFINITY;
  let bestEntity = false;
  entries.forEach((e, i) => {
    const q = qualityFor(e) ?? 0;
    const p = priceUsdcFor(e, network);
    const entityHit = category === "labels" &&
      describesEntityAttribution(e.description);
    if (
      q > bestQuality ||
      (q === bestQuality && p < bestPrice) ||
      (q === bestQuality && p === bestPrice && entityHit && !bestEntity)
    ) {
      bestIdx = i;
      bestQuality = q;
      bestPrice = p;
      bestEntity = entityHit;
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

/**
 * Filter durably-blocked candidates per category. A service is durably blocked
 * if it has previously failed with an error code that signals a config-level
 * mismatch (e.g. catalog-vs-runtime price drift on x402 upstreams). If
 * filtering would empty a category, the blocked entries are re-included —
 * better to try a known-bad service than to skip the category entirely.
 */
async function filterDurablyBlocked(
  candidates: Partial<Record<Category, DiscoveryEntry[]>>,
): Promise<Partial<Record<Category, DiscoveryEntry[]>>> {
  const out: Partial<Record<Category, DiscoveryEntry[]>> = {};
  for (
    const [cat, entries] of Object.entries(candidates) as [
      Category,
      DiscoveryEntry[],
    ][]
  ) {
    const blockedFlags = await Promise.all(
      entries.map((e) => isDurablyBlocked(e.resource)),
    );
    const kept = entries.filter((_, i) => !blockedFlags[i]);
    let final: DiscoveryEntry[];
    if (kept.length === 0 && entries.length > 0) {
      console.warn(
        `[rank] all candidates for ${cat} are durably blocked — re-including them as degraded fallback`,
      );
      final = entries;
    } else {
      if (kept.length < entries.length) {
        const dropped = entries.length - kept.length;
        console.warn(
          `[rank] filtered ${dropped} durably-blocked candidate(s) from ${cat}`,
        );
      }
      final = kept;
    }
    // Quality demotion: push services with proven weak coverage to the end
    // (preserve relative order otherwise). Doesn't drop them — they can still
    // be picked if no better candidate exists, but they're no longer the
    // default. The LLM rerank also sees their position and biases away.
    const demotedFlags = await Promise.all(
      final.map((e) => isQualityDemoted(e.resource)),
    );
    if (demotedFlags.some(Boolean)) {
      const promoted = final.filter((_, i) => !demotedFlags[i]);
      const demoted = final.filter((_, i) => demotedFlags[i]);
      if (demoted.length > 0) {
        console.warn(
          `[rank] quality-demoted ${demoted.length} candidate(s) in ${cat} (empty-on-rich-history pattern detected)`,
        );
      }
      final = [...promoted, ...demoted];
    }
    out[cat] = final;
  }
  return out;
}

export async function rankServices(
  candidates: DiscoveryCandidatesByCategory,
  llm: LlmClient = defaultLlm,
): Promise<RankedService[]> {
  const network = candidates.walletNetwork === "base"
    ? "eip155:8453"
    : "eip155:84532";
  const filteredCandidates = await filterDurablyBlocked(candidates.candidates);
  const entries = Object.entries(filteredCandidates) as [
    Category,
    DiscoveryEntry[],
  ][];
  if (entries.length === 0) return [];

  let selection: RankedSelection | null = null;
  try {
    const prompt = await buildPrompt(filteredCandidates, network);
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
    const cats = entries.map(([cat]) => cat).join(",");
    console.warn(
      `[rank] LLM rerank failed for categories [${cats}], falling back to quality-sort: ${
        (e as Error).message
      }`,
    );
  }

  const out: RankedService[] = [];

  if (selection) {
    for (const s of selection.selections) {
      const list = filteredCandidates[s.category];
      if (!list || s.resourceIndex < 0 || s.resourceIndex >= list.length) {
        continue;
      }
      out.push(
        toRanked(s.category, list[s.resourceIndex], network, s.rationale),
      );
    }
  } else {
    for (const [cat, list] of entries) {
      const idx = fallbackPick(list, network, cat);
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
