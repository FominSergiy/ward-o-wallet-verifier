import type { Category } from "./types";

// One-sentence explanation per category, surfaced as a native `title`
// tooltip on category chips in PlanCard and VerdictCard. Keep these
// audience-facing and concrete — they're the first thing a new user sees
// when they hover an unfamiliar label like "web_sentiment".
export const CATEGORY_HINTS: Record<Category, string> = {
  sanctions:
    "Checks whether the address is on OFAC or similar sanctions lists.",
  labels:
    "Identifies known entities attributed to the address (CEX wallets, mixers, contracts, etc.).",
  onchain_history:
    "Inspects the address's transaction history and on-chain activity patterns.",
  web_sentiment:
    "Searches public web and social signals for mentions or reputation of this address.",
  ens:
    "Resolves the address to a human-readable .eth name, if one is registered.",
};
