import type { Category } from "../agent/types.ts";

export const CATEGORY_QUERIES: Record<Exclude<Category, "ens">, string> = {
  sanctions: "wallet address sanctions OFAC AML screening",
  labels: "wallet address entity label identification attribution",
  onchain_history: "ethereum wallet transaction history tx count balance",
  web_sentiment: "web search news social mentions scam exploit",
  contract_analysis: "smart contract address source code audit security analysis",
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
): Partial<Record<Category, string>> {
  const out: Partial<Record<Category, string>> = {};
  for (const cat of categories) {
    if (!KNOWN_CATEGORIES.has(cat)) {
      throw new Error(`Unknown category: ${cat}`);
    }
    if (cat === "ens") continue;
    out[cat] = CATEGORY_QUERIES[cat];
  }
  return out;
}
