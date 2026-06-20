// CHAIN-PRIMITIVE FALLBACK: ENS reverse resolution.
//
// ENS reverse resolution maps an address back to its primary `.eth` name (e.g.
// 0xd8dA…6045 → "vitalik.eth"). This is a free public-good read against the
// ENS registry + resolver contracts on Ethereum mainnet — not a vendor
// service, not discoverable via Bazaar.
//
// Why this is not a "hard-coded vendor URL" violation:
//   - No HTTP endpoint, no API key, no commercial relationship.
//   - Reads the ENS registry / resolver smart contracts via the SAME RPC
//     infrastructure used by onchain_viem.ts. Trust model identical to
//     viem.getCode().
//   - The signal is confirmatory (positive prior for ENS-doxxed wallets) and
//     is only consulted when the wallet's chain is Ethereum mainnet — ENS
//     reverse resolution doesn't natively exist on L2s.
//
// See docs/features/synthesis-signal-lift.md for the full design rationale.

import {
  type Address,
  createPublicClient,
  http,
  type PublicClient,
  type Transport,
} from "viem";
import { mainnet } from "viem/chains";
import type { Chain } from "./types.ts";
import { getKv, type KvStore } from "../cache/kv.ts";

const ENS_CACHE_TTL_MS = parseInt(
  Deno.env.get("ENS_CACHE_TTL_MS") ?? "86400000",
  10,
);

// viem's getEnsName uses the Universal Resolver with CCIP-read batch gateways.
// Cloudflare-eth.com returns "Internal error" for this call, so we default to
// publicnode.com which handles ENS lookups correctly. Operators can override
// via RPC_URL_ETH_ENS (preferred) or fall back to the shared RPC_URL_ETH.
const ETH_RPC_URL = Deno.env.get("RPC_URL_ETH_ENS") ??
  Deno.env.get("RPC_URL_ETH") ??
  "https://ethereum-rpc.publicnode.com";

export interface EnsResolution {
  source: "viem_ens";
  chain: Chain;
  address: string;
  ensName: string | null;
  rpcUrl: string;
  checkedAt: string;
}

export interface ResolveEnsOpts {
  /** Pre-built viem client (used by tests). */
  client?: PublicClient;
  /** Inject only the transport — useful when tests stub HTTP responses. */
  transport?: Transport;
  /** KV store override for tests (skips the global singleton). */
  cache?: KvStore;
}

// ENS reverse resolution is a property of Ethereum mainnet. L2s like Base,
// Polygon, etc. can have their own naming systems but ENS reverse is mainnet-
// only. We surface this distinction via `not_applicable` rather than failing.
export function ensSupportedFor(chain: Chain): boolean {
  return chain === "eth";
}

export async function resolveEns(
  address: string,
  chain: Chain,
  opts: ResolveEnsOpts = {},
): Promise<EnsResolution> {
  if (!ensSupportedFor(chain)) {
    return {
      source: "viem_ens",
      chain,
      address,
      ensName: null,
      rpcUrl: ETH_RPC_URL,
      checkedAt: new Date().toISOString(),
    };
  }

  const cache = opts.cache ?? await getKv();
  const cacheKey = `ens:${address.toLowerCase()}:${chain}`;
  const cached = await cache.get<EnsResolution>(cacheKey);
  if (cached) return cached;

  // deno-lint-ignore no-explicit-any
  const client: PublicClient = (opts.client ?? createPublicClient({
    chain: mainnet,
    transport: opts.transport ?? http(ETH_RPC_URL),
  })) as any;

  const ensName = await client.getEnsName({ address: address as Address });

  const result: EnsResolution = {
    source: "viem_ens",
    chain,
    address,
    ensName: ensName ?? null,
    rpcUrl: ETH_RPC_URL,
    checkedAt: new Date().toISOString(),
  };

  await cache.set(cacheKey, result, ENS_CACHE_TTL_MS);
  return result;
}
