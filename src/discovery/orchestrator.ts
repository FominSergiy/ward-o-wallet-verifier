import type { Category } from "../agent/types.ts";
import { searchDiscovery } from "./client.ts";
import { queriesForCategories } from "./queries.ts";
import {
  toCaip2,
  type DiscoveryCandidatesByCategory,
  type DiscoveryEntry,
  type SearchParams,
  type WalletNetwork,
} from "./types.ts";

type SearchFn = (
  params: SearchParams,
  fetchFn?: typeof globalThis.fetch,
) => Promise<DiscoveryEntry[]>;

export interface FetchCandidatesOpts {
  limit?: number;
  maxUsdPrice?: number;
  client?: SearchFn;
  fetchFn?: typeof globalThis.fetch;
}

type Outcome =
  | { cat: Category; ok: true; entries: DiscoveryEntry[] }
  | { cat: Category; ok: false; error: string };

export async function fetchCandidates(
  categories: Category[],
  walletNetwork: WalletNetwork,
  opts: FetchCandidatesOpts = {},
): Promise<DiscoveryCandidatesByCategory> {
  const client = opts.client ?? searchDiscovery;
  const caip2 = toCaip2(walletNetwork);
  const queries = queriesForCategories(categories);

  const candidates: Partial<Record<Category, DiscoveryEntry[]>> = {};
  const errors: Partial<Record<Category, string>> = {};

  const entries = Object.entries(queries) as [Category, string][];
  const settled = await Promise.all(
    entries.map(async ([cat, query]): Promise<Outcome> => {
      try {
        const r = await client(
          { query, network: caip2, limit: opts.limit, maxUsdPrice: opts.maxUsdPrice },
          opts.fetchFn,
        );
        return { cat, ok: true, entries: r };
      } catch (e) {
        return { cat, ok: false, error: (e as Error).message };
      }
    }),
  );

  for (const r of settled) {
    if (r.ok) {
      if (r.entries.length > 0) candidates[r.cat] = r.entries;
      else errors[r.cat] = "no results";
    } else {
      errors[r.cat] = r.error;
    }
  }

  return { walletNetwork, candidates, errors };
}
