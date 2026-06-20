import type { Chain } from "./types.ts";
import type { WalletVerdict } from "./verdict.ts";

// Bump when WalletVerdict shape changes in a way that makes old cached entries
// unreadable. Cache misses are free; stale hits would be bugs.
export const SCHEMA_VERSION = "1";

const TTL_SAFE = 24 * 60 * 60 * 1000; // 24h in ms
const TTL_DNT = 5 * 60 * 1000; // 5min — short-lived to limit false-positive exposure

export interface VerdictCache {
  get(chain: Chain, address: string): Promise<WalletVerdict | null>;
  set(chain: Chain, address: string, verdict: WalletVerdict): Promise<void>;
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
      const entry = await kv.get<WalletVerdict>(cacheKey(chain, address));
      return entry.value ?? null;
    },
    async set(chain, address, verdict) {
      const ttl = ttlFor(verdict);
      if (ttl === null) return;
      await kv.set(cacheKey(chain, address), verdict, { expireIn: ttl });
    },
  };
}

// In-memory implementation for unit tests — no Deno.openKv() required.
export function memoryCache(): VerdictCache & {
  store: Map<string, WalletVerdict>;
} {
  const store = new Map<string, WalletVerdict>();
  function storeKey(chain: Chain, address: string): string {
    return `${chain}:${address.toLowerCase()}`;
  }
  return {
    store,
    get(chain, address) {
      return Promise.resolve(store.get(storeKey(chain, address)) ?? null);
    },
    set(chain, address, verdict) {
      if (ttlFor(verdict) === null) return Promise.resolve();
      store.set(storeKey(chain, address), verdict);
      return Promise.resolve();
    },
  };
}
