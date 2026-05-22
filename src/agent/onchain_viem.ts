// Free, public-RPC-backed onchain_history fetcher. Used as a fallback after
// x402 invocation + alternates have exhausted, so we still get coverage for
// the onchain_history category when the discovered service is dead (as was
// the case 5/5 in the v1 real-wallet-test report).

import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
  type Transport,
} from "viem";
import {
  arbitrum,
  base,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";
import type { Chain } from "../dag/types.ts";

const DEFAULT_RPCS: Record<string, string> = {
  eth: Deno.env.get("RPC_URL_ETH") ?? "https://cloudflare-eth.com",
  base: Deno.env.get("RPC_URL_BASE") ?? "https://mainnet.base.org",
  "base-sepolia": Deno.env.get("RPC_URL_BASE_SEPOLIA") ??
    "https://sepolia.base.org",
  polygon: Deno.env.get("RPC_URL_POLYGON") ?? "https://polygon-rpc.com",
  arbitrum: Deno.env.get("RPC_URL_ARBITRUM") ?? "https://arb1.arbitrum.io/rpc",
  optimism: Deno.env.get("RPC_URL_OPTIMISM") ?? "https://mainnet.optimism.io",
};

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
  const rpcUrl = DEFAULT_RPCS[chain];
  // deno-lint-ignore no-explicit-any
  const client = createPublicClient({
    chain: VIEM_CHAINS[chain],
    transport: transport ?? http(rpcUrl),
  }) as any;
  return { client, rpcUrl };
}

export async function fetchOnchainHistory(
  address: string,
  chain: Chain,
  opts: FetchOnchainHistoryOpts = {},
): Promise<OnchainHistory> {
  if (!isSupported(chain)) throw new UnsupportedChainError(chain);

  const built = opts.client
    ? { client: opts.client, rpcUrl: DEFAULT_RPCS[chain] }
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
