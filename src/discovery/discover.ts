import type { Category } from "../agent/types.ts";
import { defaultLlm, type LlmClient } from "../agent/llm.ts";
import { detectWalletNetwork } from "./network.ts";
import { fetchCandidates } from "./orchestrator.ts";
import { rankServices } from "./rank.ts";
import type {
  DiscoveryPlan,
  RankedService,
  WalletNetwork,
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

  const resolvedCats = new Set(services.map((s) => s.category));
  const unresolvedCategories = categories.filter(
    (c) => c !== "ens" && !resolvedCats.has(c),
  );

  const totalEstimatedCostUsdc = services.reduce((s, x) => s + x.priceUsdc, 0);

  return {
    address,
    walletNetwork,
    services,
    totalEstimatedCostUsdc,
    unresolvedCategories,
    generatedAt: new Date().toISOString(),
  };
}
