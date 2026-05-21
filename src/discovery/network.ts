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

export async function detectWalletNetwork(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<WalletNetwork> {
  const apiKey = Deno.env.get("AGNIC_API_KEY");
  if (!apiKey) throw new Error("AGNIC_API_KEY not set");

  const [mainnet, sepolia] = await Promise.all([
    fetchBalance("base", apiKey, fetchFn),
    fetchBalance(null, apiKey, fetchFn),
  ]);

  const mainnetUsdc = mainnet ? parseFloat(mainnet.usdcBalance) : 0;
  const sepoliaUsdc = sepolia ? parseFloat(sepolia.usdcBalance) : 0;

  if (mainnetUsdc > 0) return "base";
  if (sepoliaUsdc > 0) return "base-sepolia";

  throw new WalletUnfundedError(
    mainnet?.address ?? null,
    sepolia?.address ?? null,
  );
}

export { toCaip2, type WalletNetwork } from "./types.ts";
