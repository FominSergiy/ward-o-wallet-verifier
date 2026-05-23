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
  | { cat: Category; query: string; ok: true; entries: DiscoveryEntry[] }
  | { cat: Category; query: string; ok: false; error: string };

export async function fetchCandidates(
  categories: Category[],
  walletNetwork: WalletNetwork,
  opts: FetchCandidatesOpts = {},
): Promise<DiscoveryCandidatesByCategory> {
  const client = opts.client ?? searchDiscovery;
  const caip2 = toCaip2(walletNetwork);
  const queries = queriesForCategories(categories);

  // Flatten (category, query) pairs so all queries fire in parallel — a
  // category with two queries (e.g. labels: attribution + phishing) issues
  // two independent catalog searches whose results we then union.
  const queryPairs: [Category, string][] = [];
  for (const [cat, qs] of Object.entries(queries) as [Category, string[]][]) {
    for (const q of qs) queryPairs.push([cat, q]);
  }

  const settled = await Promise.all(
    queryPairs.map(async ([cat, query]): Promise<Outcome> => {
      try {
        const r = await client(
          { query, network: caip2, limit: opts.limit, maxUsdPrice: opts.maxUsdPrice },
          opts.fetchFn,
        );
        return { cat, query, ok: true, entries: r };
      } catch (e) {
        return { cat, query, ok: false, error: (e as Error).message };
      }
    }),
  );

  const candidates: Partial<Record<Category, DiscoveryEntry[]>> = {};
  const errors: Partial<Record<Category, string>> = {};
  const seenByCategory = new Map<Category, Set<string>>();
  const errorsByCategory = new Map<Category, string[]>();
  const successByCategory = new Set<Category>();

  for (const r of settled) {
    if (r.ok) {
      successByCategory.add(r.cat);
      if (r.entries.length === 0) continue;
      let seen = seenByCategory.get(r.cat);
      if (!seen) {
        seen = new Set();
        seenByCategory.set(r.cat, seen);
        candidates[r.cat] = [];
      }
      const bucket = candidates[r.cat]!;
      for (const entry of r.entries) {
        if (seen.has(entry.resource)) continue;
        seen.add(entry.resource);
        bucket.push(entry);
      }
    } else {
      const arr = errorsByCategory.get(r.cat) ?? [];
      arr.push(r.error);
      errorsByCategory.set(r.cat, arr);
    }
  }

  // A category is only "errored" if NONE of its queries succeeded with any
  // entries. If any query succeeded but returned zero entries, surface that
  // as "no results" — same shape as the previous single-query behavior.
  for (const [cat, qs] of Object.entries(queries) as [Category, string[]][]) {
    if (candidates[cat] && candidates[cat]!.length > 0) continue;
    if (successByCategory.has(cat)) {
      errors[cat] = "no results";
      continue;
    }
    const errs = errorsByCategory.get(cat) ?? [];
    if (errs.length === qs.length) errors[cat] = errs.join("; ");
  }

  return { walletNetwork, candidates, errors };
}
