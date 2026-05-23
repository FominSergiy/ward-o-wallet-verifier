import type { Category } from "../agent/types.ts";

// One or more Bazaar catalog search queries per category. Multiple queries
// widen the candidate pool — e.g. `labels` runs both a CEX/attribution query
// and a phishing/scam-blocklist query so the ranker can choose between the
// two service families. Candidate results are unioned and de-duplicated by
// resource URL upstream (see fetchCandidates).
export const CATEGORY_QUERIES: Record<Exclude<Category, "ens">, string[]> = {
  sanctions: ["wallet address sanctions OFAC AML screening"],
  labels: [
    "wallet address attribution exchange cex mixer entity tag known cluster",
    "wallet address phishing scam malicious blocklist goplus chainabuse scamsniffer risk reputation",
  ],
  onchain_history: ["ethereum wallet transaction history tx count balance"],
  web_sentiment: [
    "wallet address reputation news article social media coverage exchange hack exploit incident",
  ],
  contract_analysis: [
    "smart contract source code audit security vulnerability erc20 token analysis",
  ],
};

const KNOWN_CATEGORIES = new Set<string>([
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "ens",
  "contract_analysis",
]);

export function queriesForCategories(
  categories: Category[],
): Partial<Record<Category, string[]>> {
  const out: Partial<Record<Category, string[]>> = {};
  for (const cat of categories) {
    if (!KNOWN_CATEGORIES.has(cat)) {
      throw new Error(`Unknown category: ${cat}`);
    }
    if (cat === "ens") continue;
    out[cat] = CATEGORY_QUERIES[cat as Exclude<Category, "ens">];
  }
  return out;
}
