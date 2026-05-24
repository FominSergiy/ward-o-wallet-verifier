import type { Category } from "../agent/types.ts";

export const CATEGORY_QUERIES: Record<Exclude<Category, "ens">, string> = {
  sanctions: "wallet address sanctions OFAC AML screening",
  // Extended terms cover the high-coverage label providers' typical
  // self-descriptions: name tag, hot wallet identification, entity attribution.
  // Adding these widens the candidate set without locking in any specific
  // provider — the rerank still picks per-call.
  labels:
    "wallet address attribution exchange cex mixer entity tag known cluster name tag hot wallet entity attribution known address database",
  // Lean toward services that surface tx history depth — not just balance.
  // Orbis's /balance endpoint matched the old query verbatim and won this
  // category by default; the added terms widen the candidate set toward
  // providers that actually describe activity, not just current state.
  onchain_history:
    "ethereum wallet transaction history transaction count first seen last activity tx history balance",
  // Drop "reputation" and "hack exploit incident" — both terms also describe
  // risk-scoring APIs (Orbis wallet-address-risk-api matched this query and
  // was being picked for web_sentiment despite being a risk scorer). Lean
  // into news/social/author terms that match true sentiment providers.
  web_sentiment:
    "wallet address news article social media coverage sentiment author byline forum post",
};

const KNOWN_CATEGORIES = new Set<string>([
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "ens",
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
