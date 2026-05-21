import type { Category } from "../agent/types.ts";
import { defaultLlm, type LlmClient } from "../agent/llm.ts";
import { detectWalletNetwork } from "./network.ts";
import { fetchCandidates } from "./orchestrator.ts";
import { rankServices } from "./rank.ts";
import {
  extractBazaarInfo,
  type DiscoveryCandidatesByCategory,
  type DiscoveryEntry,
  type DiscoveryPlan,
  type RankedService,
  type WalletNetwork,
} from "./types.ts";

export interface DiscoverOpts {
  llm?: LlmClient;
  detectNetwork?: () => Promise<WalletNetwork>;
  fetcher?: typeof fetchCandidates;
  ranker?: typeof rankServices;
  limit?: number;
  maxUsdPrice?: number;
}

export async function discover(
  address: string,
  categories: Category[],
  opts: DiscoverOpts = {},
): Promise<DiscoveryPlan> {
  const detect = opts.detectNetwork ?? (() => detectWalletNetwork());
  const fetcher = opts.fetcher ?? fetchCandidates;
  const ranker = opts.ranker ?? rankServices;
  const llm = opts.llm ?? defaultLlm;

  const walletNetwork = await detect();

  const candidates = await fetcher(categories, walletNetwork, {
    limit: opts.limit,
    maxUsdPrice: opts.maxUsdPrice,
  });

  const services: RankedService[] = await ranker(candidates, llm);
  const alternates = buildAlternates(candidates, services, walletNetwork);

  const resolvedCats = new Set(services.map((s) => s.category));
  const unresolvedCategories = categories.filter(
    (c) => c !== "ens" && !resolvedCats.has(c),
  );

  const totalEstimatedCostUsdc = services.reduce((s, x) => s + x.priceUsdc, 0);

  return {
    address,
    walletNetwork,
    services,
    alternates,
    totalEstimatedCostUsdc,
    unresolvedCategories,
    generatedAt: new Date().toISOString(),
  };
}

function buildAlternates(
  candidates: DiscoveryCandidatesByCategory,
  primary: RankedService[],
  walletNetwork: WalletNetwork,
): Partial<Record<Category, RankedService[]>> {
  const network = walletNetwork === "base" ? "eip155:8453" : "eip155:84532";
  const primaryByCategory = new Map(primary.map((s) => [s.category, s.resource]));
  const out: Partial<Record<Category, RankedService[]>> = {};
  for (const [cat, entries] of Object.entries(candidates.candidates) as [
    Category,
    DiscoveryEntry[],
  ][]) {
    const primaryUrl = primaryByCategory.get(cat);
    const remaining = entries.filter((e) => e.resource !== primaryUrl);
    if (remaining.length === 0) continue;
    // Sort by quality desc, then price asc — same fallback heuristic as
    // rank.fallbackPick — so retries pick the most likely-working next.
    const sorted = [...remaining].sort((a, b) => {
      const qa = a.extensions?.bazaar?.quality?.l30DaysUniquePayers ?? 0;
      const qb = b.extensions?.bazaar?.quality?.l30DaysUniquePayers ?? 0;
      if (qa !== qb) return qb - qa;
      const pa = priceUsdcFor(a, network);
      const pb = priceUsdcFor(b, network);
      return pa - pb;
    });
    out[cat] = sorted.map((e) =>
      entryToRanked(cat, e, network, "Alternate candidate (post-rerank).")
    );
  }
  return out;
}

function priceUsdcFor(e: DiscoveryEntry, network: string): number {
  const a = e.accepts.find((x) => x.network === network) ?? e.accepts[0];
  return parseInt(a.amount, 10) / 1_000_000;
}

function entryToRanked(
  cat: Category,
  entry: DiscoveryEntry,
  network: string,
  rationale: string,
): RankedService {
  const accept = entry.accepts.find((a) => a.network === network) ??
    entry.accepts[0];
  return {
    category: cat,
    resource: entry.resource,
    description: entry.description ?? "",
    priceUsdc: priceUsdcFor(entry, network),
    network,
    payTo: accept.payTo,
    scheme: accept.scheme,
    qualityScore: entry.extensions?.bazaar?.quality?.l30DaysUniquePayers ?? null,
    rationale,
    inputInfo: extractBazaarInfo(entry),
  };
}
