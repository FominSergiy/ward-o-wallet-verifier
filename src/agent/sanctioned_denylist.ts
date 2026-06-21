import type { Chain } from "./types.ts";

// Long-TTL store of known-sanctioned addresses, warmed by the vetter cron from
// the OFAC SDN list (see src/vetter/run.ts#warmSanctionedDenylist + ofac_list.ts).
//
// WHY THIS IS SEPARATE FROM THE VERDICT CACHE:
//   The verdict cache gives `do_not_transact` a deliberate 5-minute TTL
//   (verdict_cache.ts) to bound false-positive exposure. Warming sanctions into
//   it would expire 5 minutes later and be useless against a 12h cron.
//   Oracle/OFAC-confirmed sanctions are deterministic, not false-positive-prone,
//   so they get this dedicated long-TTL store instead. Checked at the top of the
//   verify pipeline: a hit returns a deterministic do_not_transact verdict in
//   <100ms from a single Deno KV read, with zero USDC spend and no RPC fan-out.
//
// SIZE: bounded by |OFAC list| (~hundreds), NOT by user traffic — the cron
// writes exactly the fetched set. TTL is the garbage collector: each run
// re-asserts the current OFAC set (refreshing TTLs); de-listed addresses are
// not refreshed and auto-expire.

// Bump when DenylistEntry shape changes in a way that makes old entries
// unreadable. Misses are free (fall through to the live oracle path).
export const DENYLIST_SCHEMA_VERSION = "1";

// 72h: several cron intervals long, so the denylist survives a few failed
// fetches (stays protective) while still de-listing within ~3 days. Erring long
// is the safe direction for a sanctions list.
export const DEFAULT_DENYLIST_TTL_MS = 72 * 60 * 60 * 1000;

export interface DenylistEntry {
  /** Human-readable reason, e.g. "OFAC SDN". */
  reason: string;
  /** Provenance of the entry, e.g. "ofac:0xB10C" or "local-seed". */
  source: string;
  /** ISO timestamp this entry was last warmed. */
  warmedAt: string;
}

export interface SanctionedDenylist {
  /** Returns the entry if the address is denylisted, else null. */
  has(chain: Chain, address: string): Promise<DenylistEntry | null>;
  set(
    chain: Chain,
    address: string,
    entry: DenylistEntry,
    ttlMs?: number,
  ): Promise<void>;
}

function denylistKey(chain: Chain, address: string): Deno.KvKey {
  return [
    "sanctioned_denylist",
    chain,
    address.toLowerCase(),
    DENYLIST_SCHEMA_VERSION,
  ];
}

export function denoKvDenylist(kv: Deno.Kv): SanctionedDenylist {
  return {
    async has(chain, address) {
      const entry = await kv.get<DenylistEntry>(denylistKey(chain, address));
      return entry.value ?? null;
    },
    async set(chain, address, entry, ttlMs = DEFAULT_DENYLIST_TTL_MS) {
      await kv.set(denylistKey(chain, address), entry, { expireIn: ttlMs });
    },
  };
}

// In-memory implementation for unit tests — no Deno.openKv() required. Ignores
// TTL (tests don't exercise expiry).
export function memoryDenylist(): SanctionedDenylist & {
  store: Map<string, DenylistEntry>;
} {
  const store = new Map<string, DenylistEntry>();
  function storeKey(chain: Chain, address: string): string {
    return `${chain}:${address.toLowerCase()}`;
  }
  return {
    store,
    has(chain, address) {
      return Promise.resolve(store.get(storeKey(chain, address)) ?? null);
    },
    set(chain, address, entry) {
      store.set(storeKey(chain, address), entry);
      return Promise.resolve();
    },
  };
}
