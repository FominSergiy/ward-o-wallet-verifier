// Free, public-RPC-backed onchain_history fetcher. Used as a fallback after
// x402 invocation + alternates have exhausted, so we still get coverage for
// the onchain_history category when the discovered service is dead (as was
// the case 5/5 in the v1 real-wallet-test report).

import {
  type Address,
  createPublicClient,
  fallback,
  http,
  type PublicClient,
  type Transport,
} from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";
import type { Chain } from "./types.ts";

// Multiple public RPCs per chain so a single dead/rate-limited provider can't
// sink the free onchain_history fallback. The previous single default
// (https://cloudflare-eth.com) was returning "Cannot fulfill request" in prod,
// so EVERY viem rescue failed (0/12 success) — the fallback meant to guarantee
// onchain coverage never worked. We now build a viem `fallback` transport over
// this ordered list, which ranks providers and fails over automatically. Each
// chain's env var (e.g. RPC_URL_ETH) overrides the defaults and may be a single
// URL or a comma-separated list (e.g. a paid Alchemy/Infura endpoint first).
const DEFAULT_RPC_LIST: Record<string, string[]> = {
  eth: [
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
  ],
  base: ["https://mainnet.base.org", "https://base.llamarpc.com"],
  "base-sepolia": ["https://sepolia.base.org"],
  polygon: ["https://polygon-rpc.com", "https://polygon.llamarpc.com"],
  arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.llamarpc.com"],
  optimism: ["https://mainnet.optimism.io", "https://optimism.llamarpc.com"],
};

const RPC_ENV_VAR: Record<string, string> = {
  eth: "RPC_URL_ETH",
  base: "RPC_URL_BASE",
  "base-sepolia": "RPC_URL_BASE_SEPOLIA",
  polygon: "RPC_URL_POLYGON",
  arbitrum: "RPC_URL_ARBITRUM",
  optimism: "RPC_URL_OPTIMISM",
};

/**
 * Ordered RPC URL list for a chain: the env override (single URL or
 * comma-separated list) when set, otherwise the built-in public defaults.
 * Exported for unit testing the parse/override behavior.
 */
export function rpcUrlsForChain(chain: string): string[] {
  const envName = RPC_ENV_VAR[chain];
  const raw = envName ? Deno.env.get(envName) : undefined;
  if (raw) {
    const urls = raw.split(",").map((u) => u.trim()).filter((u) =>
      u.length > 0
    );
    if (urls.length > 0) return urls;
  }
  return DEFAULT_RPC_LIST[chain] ?? [];
}

// viem chain definitions per our Chain enum value.
const VIEM_CHAINS = {
  eth: mainnet,
  base,
  polygon,
  arbitrum,
  optimism,
} as const;

export type SupportedChain = keyof typeof VIEM_CHAINS;

export class UnsupportedChainError extends Error {
  constructor(public readonly chain: string) {
    super(`onchain_viem fallback does not support chain "${chain}"`);
    this.name = "UnsupportedChainError";
  }
}

export interface OnchainHistory {
  source: "viem";
  chain: Chain;
  address: string;
  txCount: number;
  balanceWei: string; // bigint serialized — keep exact precision for downstream
  balanceEth: number; // floating-point convenience for Opus consumption
  currentBlock: number;
  rpcUrl: string;
}

export interface FetchOnchainHistoryOpts {
  /** Inject a fully-built viem PublicClient (used by tests with custom Transport). */
  client?: PublicClient;
  /** Inject only the transport — useful when tests want to stub HTTP responses. */
  transport?: Transport;
}

function isSupported(chain: string): chain is SupportedChain {
  return chain in VIEM_CHAINS;
}

function buildClient(chain: SupportedChain, transport?: Transport): {
  client: PublicClient;
  rpcUrl: string;
} {
  const urls = rpcUrlsForChain(chain);
  // A `fallback` transport tries each provider in order and fails over on
  // error, so one dead public RPC no longer kills the rescue. `rpcUrl` keeps the
  // primary for logging/receipts.
  const built = transport ?? fallback(urls.map((u) => http(u)));
  // deno-lint-ignore no-explicit-any
  const client = createPublicClient({
    chain: VIEM_CHAINS[chain],
    transport: built,
  }) as any;
  return { client, rpcUrl: urls[0] ?? "" };
}

/**
 * True iff the address has deployed bytecode on the given chain — i.e. it's a
 * contract, not an EOA. Exposed as a chain primitive for callers that need to
 * branch on address shape.
 *
 * Errors (unsupported chain, RPC failure) return false — callers should treat
 * "unknown" as "not a contract" so we don't accidentally skip downstream paths
 * on a transient RPC blip.
 */
export async function isContract(
  address: string,
  chain: Chain,
  opts: FetchOnchainHistoryOpts = {},
): Promise<boolean> {
  if (!isSupported(chain)) return false;
  try {
    const built = opts.client
      ? { client: opts.client, rpcUrl: rpcUrlsForChain(chain)[0] ?? "" }
      : buildClient(chain, opts.transport);
    const code = await built.client.getCode({ address: address as Address });
    return code !== undefined && code !== "0x";
  } catch {
    return false;
  }
}

export async function fetchOnchainHistory(
  address: string,
  chain: Chain,
  opts: FetchOnchainHistoryOpts = {},
): Promise<OnchainHistory> {
  if (!isSupported(chain)) throw new UnsupportedChainError(chain);

  const built = opts.client
    ? { client: opts.client, rpcUrl: rpcUrlsForChain(chain)[0] ?? "" }
    : buildClient(chain, opts.transport);

  const { client, rpcUrl } = built;
  const addr = address as Address;

  // Run the three reads in parallel — they're independent.
  const [txCount, balanceWei, currentBlock] = await Promise.all([
    client.getTransactionCount({ address: addr }),
    client.getBalance({ address: addr }),
    client.getBlockNumber(),
  ]);

  const balanceEth = Number(balanceWei) / 1e18;

  return {
    source: "viem",
    chain,
    address,
    txCount,
    balanceWei: balanceWei.toString(),
    balanceEth,
    currentBlock: Number(currentBlock),
    rpcUrl,
  };
}
