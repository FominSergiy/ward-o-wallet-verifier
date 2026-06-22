import type { Chain } from "./types.ts";
import type { WalletVerdict } from "./verdict.ts";
import type { ServiceInvocationOutcome } from "./invoke_service.ts";
import type { WalletNetwork } from "../discovery/types.ts";

// Bump when the cached shape changes in a way that makes old entries
// unreadable. Cache misses are free; stale hits would be bugs.
// "2": store the full result envelope (outcomes + cost totals + network)
// instead of just the WalletVerdict, so a cache hit can re-render the paid
// services breakdown identically to a fresh deep run.
export const SCHEMA_VERSION = "2";

const TTL_SAFE = 24 * 60 * 60 * 1000; // 24h in ms
const TTL_DNT = 5 * 60 * 1000; // 5min — short-lived to limit false-positive exposure

// The full deep-run envelope we persist. Keeping the receipts (`outcomes`) and
// the per-run cost totals means a cache hit renders the same paid-services
// breakdown a fresh run would — the spend just gets reported as $0 for THIS
// run (the original cost is preserved here as the historical figure).
export interface CachedVerdict {
  verdict: WalletVerdict;
  outcomes: ServiceInvocationOutcome[];
  totalSpentUsdc: number;
  totalLlmCostUsd: number;
  walletNetwork: WalletNetwork;
}

export interface VerdictCache {
  get(chain: Chain, address: string): Promise<CachedVerdict | null>;
  set(chain: Chain, address: string, entry: CachedVerdict): Promise<void>;
}

function cacheKey(
  chain: Chain,
  address: string,
): Deno.KvKey {
  return ["verdict_cache", chain, address.toLowerCase(), SCHEMA_VERSION];
}

function ttlFor(verdict: WalletVerdict): number | null {
  if (verdict.verdict === "safe_to_transact") return TTL_SAFE;
  if (verdict.verdict === "do_not_transact") return TTL_DNT;
  return null; // insufficient_data: never cache
}

export function denoKvCache(kv: Deno.Kv): VerdictCache {
  return {
    async get(chain, address) {
      const entry = await kv.get<CachedVerdict>(cacheKey(chain, address));
      return entry.value ?? null;
    },
    async set(chain, address, entry) {
      const ttl = ttlFor(entry.verdict);
      if (ttl === null) return;
      await kv.set(cacheKey(chain, address), entry, { expireIn: ttl });
    },
  };
}

// In-memory implementation for unit tests — no Deno.openKv() required.
export function memoryCache(): VerdictCache & {
  store: Map<string, CachedVerdict>;
} {
  const store = new Map<string, CachedVerdict>();
  function storeKey(chain: Chain, address: string): string {
    return `${chain}:${address.toLowerCase()}`;
  }
  return {
    store,
    get(chain, address) {
      return Promise.resolve(store.get(storeKey(chain, address)) ?? null);
    },
    set(chain, address, entry) {
      if (ttlFor(entry.verdict) === null) return Promise.resolve();
      store.set(storeKey(chain, address), entry);
      return Promise.resolve();
    },
  };
}
