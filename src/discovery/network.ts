import { WalletUnfundedError, type WalletNetwork } from "./types.ts";

const AGNIC_BALANCE_URL = "https://api.agnic.ai/api/balance";

interface BalanceResponse {
  usdcBalance: string;
  address: string;
  hasWallet: boolean;
  network: string;
  chainType: string;
  creditBalance: string;
  totalBalance: string;
}

async function fetchBalance(
  network: "base" | null,
  apiKey: string,
  fetchFn: typeof globalThis.fetch,
): Promise<BalanceResponse | null> {
  const url = network ? `${AGNIC_BALANCE_URL}?network=${network}` : AGNIC_BALANCE_URL;
  const resp = await fetchFn(url, { headers: { "X-Agnic-Token": apiKey } });
  if (!resp.ok) return null;
  try {
    return await resp.json() as BalanceResponse;
  } catch {
    return null;
  }
}

export interface AgnicBudget {
  usdcBalance: number;
  creditBalance: number;
  totalBalance: number;
}

/**
 * One-shot Agnic budget lookup against `base` mainnet. Used by the
 * /verify-agent pre-flight check to short-circuit requests when the
 * daily cap is exhausted. Bypasses the network-detection cache (different
 * freshness needs). Returns null if AGNIC_API_KEY is unset or the call
 * itself fails — callers should treat null as "couldn't determine, proceed".
 */
export async function fetchAgnicBudget(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<AgnicBudget | null> {
  const apiKey = Deno.env.get("AGNIC_API_KEY");
  if (!apiKey) return null;
  const r = await fetchBalance("base", apiKey, fetchFn);
  if (!r) return null;
  return {
    usdcBalance: parseFloat(r.usdcBalance),
    creditBalance: parseFloat(r.creditBalance),
    totalBalance: parseFloat(r.totalBalance),
  };
}

// Process-wide cache for the detected wallet network. The agnic /api/balance
// endpoint is aggressively rate-limited (15-minute cooldown after a small
// burst); since the funded network doesn't change between requests, cache the
// result for the lifetime of the process.
let cachedNetwork: WalletNetwork | null = null;
const NETWORK_CACHE_TTL_MS = 5 * 60_000; // 5 min — short enough to pick up funding changes
let cachedAt = 0;

export function _resetNetworkCacheForTests() {
  cachedNetwork = null;
  cachedAt = 0;
}

export async function detectWalletNetwork(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<WalletNetwork> {
  if (cachedNetwork && Date.now() - cachedAt < NETWORK_CACHE_TTL_MS) {
    return cachedNetwork;
  }

  const apiKey = Deno.env.get("AGNIC_API_KEY");
  if (!apiKey) throw new Error("AGNIC_API_KEY not set");

  const [mainnet, sepolia] = await Promise.all([
    fetchBalance("base", apiKey, fetchFn),
    fetchBalance(null, apiKey, fetchFn),
  ]);

  const mainnetUsdc = mainnet ? parseFloat(mainnet.usdcBalance) : 0;
  const sepoliaUsdc = sepolia ? parseFloat(sepolia.usdcBalance) : 0;

  let result: WalletNetwork | null = null;
  if (mainnetUsdc > 0) result = "base";
  else if (sepoliaUsdc > 0) result = "base-sepolia";

  if (!result) {
    throw new WalletUnfundedError(
      mainnet?.address ?? null,
      sepolia?.address ?? null,
    );
  }

  cachedNetwork = result;
  cachedAt = Date.now();
  return result;
}

export { toCaip2, type WalletNetwork } from "./types.ts";
