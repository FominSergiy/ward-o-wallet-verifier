// CHAIN-PRIMITIVE FALLBACK: Chainalysis Sanctions Oracle.
//
// The Chainalysis-maintained smart contract at
// 0x40C57923924B5c5c5455c48D93317139ADDaC8fb is deployed on Ethereum, Base,
// Arbitrum, Polygon, Optimism, and most other EVM chains. It exposes a single
// view function `isSanctioned(address) -> bool` that returns true iff the
// queried address is on OFAC SDN or other government sanctions lists
// Chainalysis maintains as a public good.
//
// Why this is not a "hard-coded vendor URL" violation of the self-discovery
// pitch:
//   - There is no HTTP endpoint, no API key, no rate plan, no commercial
//     relationship. The address is part of the public EVM substrate.
//   - We read on-chain state via the SAME RPC infrastructure already used by
//     onchain_viem.ts for getCode / getTransactionCount.
//   - CDP Bazaar by design surfaces *services* — on-chain primitives cannot be
//     discovered through the catalog. Trust model = identical to viem.getCode.
//
// See docs/features/synthesis-signal-lift.md for the full design rationale.

import {
  type Address,
  createPublicClient,
  http,
  type PublicClient,
  type Transport,
} from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";
import type { Chain } from "./types.ts";

export const CHAINALYSIS_ORACLE_ADDRESS =
  "0x40C57923924B5c5c5455c48D93317139ADDaC8fb" as const;

const ORACLE_ABI = [
  {
    name: "isSanctioned",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// Default RPCs for the Chainalysis oracle. Cloudflare-eth and the default
// public Base RPC silently revert the readContract call for this contract —
// publicnode.com handles the call across all major chains. The env-var
// overrides are kept in sync with onchain_viem.ts so operators can point both
// at the same private RPC if desired.
const DEFAULT_RPCS: Record<string, string> = {
  eth: Deno.env.get("RPC_URL_ETH_ORACLE") ?? Deno.env.get("RPC_URL_ETH") ??
    "https://ethereum-rpc.publicnode.com",
  base: Deno.env.get("RPC_URL_BASE_ORACLE") ?? Deno.env.get("RPC_URL_BASE") ??
    "https://base-rpc.publicnode.com",
  polygon: Deno.env.get("RPC_URL_POLYGON_ORACLE") ??
    Deno.env.get("RPC_URL_POLYGON") ??
    "https://polygon-bor-rpc.publicnode.com",
  arbitrum: Deno.env.get("RPC_URL_ARBITRUM_ORACLE") ??
    Deno.env.get("RPC_URL_ARBITRUM") ??
    "https://arbitrum-one-rpc.publicnode.com",
  optimism: Deno.env.get("RPC_URL_OPTIMISM_ORACLE") ??
    Deno.env.get("RPC_URL_OPTIMISM") ??
    "https://optimism-rpc.publicnode.com",
};

const VIEM_CHAINS = {
  eth: mainnet,
  base,
  polygon,
  arbitrum,
  optimism,
} as const;

export type OracleSupportedChain = keyof typeof VIEM_CHAINS;

export class OracleUnsupportedChainError extends Error {
  constructor(public readonly chain: string) {
    super(`Chainalysis sanctions oracle not supported on chain "${chain}"`);
    this.name = "OracleUnsupportedChainError";
  }
}

export interface OracleResult {
  source: "chainalysis_oracle";
  oracleAddress: string;
  chain: Chain;
  isSanctioned: boolean;
  checkedAt: string;
  rpcUrl: string;
}

export interface CheckSanctionsOracleOpts {
  /** Pre-built viem client (used by tests). */
  client?: PublicClient;
  /** Inject only the transport — useful when tests stub HTTP responses. */
  transport?: Transport;
}

function isSupported(chain: string): chain is OracleSupportedChain {
  return chain in VIEM_CHAINS;
}

function buildClient(chain: OracleSupportedChain, transport?: Transport): {
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

/**
 * Calls `isSanctioned(address)` on the Chainalysis oracle for the given chain.
 *
 * Throws on RPC errors / unsupported chains rather than silently returning
 * false — callers must decide how to react to inconclusive results (the
 * verifier policy is to proceed with the full x402 flow and let synthesis
 * weigh the failure as `sanctions` unresolved).
 */
export async function checkSanctionsOracle(
  address: string,
  chain: Chain,
  opts: CheckSanctionsOracleOpts = {},
): Promise<OracleResult> {
  if (!isSupported(chain)) {
    throw new OracleUnsupportedChainError(chain);
  }

  const built = opts.client
    ? { client: opts.client, rpcUrl: DEFAULT_RPCS[chain] }
    : buildClient(chain, opts.transport);

  const isSanctioned = await built.client.readContract({
    address: CHAINALYSIS_ORACLE_ADDRESS,
    abi: ORACLE_ABI,
    functionName: "isSanctioned",
    args: [address as Address],
  });

  return {
    source: "chainalysis_oracle",
    oracleAddress: CHAINALYSIS_ORACLE_ADDRESS,
    chain,
    isSanctioned: isSanctioned as boolean,
    checkedAt: new Date().toISOString(),
    rpcUrl: built.rpcUrl,
  };
}

export function isOracleSupportedChain(chain: string): boolean {
  return isSupported(chain);
}
