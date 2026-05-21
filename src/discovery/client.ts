import { DiscoveryFetchError, type DiscoveryEntry, type SearchParams } from "./types.ts";

const SEARCH_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";

interface RawSearchResponse {
  resources?: DiscoveryEntry[];
  partialResults?: boolean;
  searchMethod?: string;
  x402Version?: number;
}

export async function searchDiscovery(
  params: SearchParams,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<DiscoveryEntry[]> {
  const q = new URLSearchParams({
    query: params.query,
    network: params.network,
    limit: String(params.limit ?? 10),
  });
  if (params.maxUsdPrice !== undefined) {
    q.set("maxUsdPrice", String(params.maxUsdPrice));
  }
  const url = `${SEARCH_URL}?${q.toString()}`;

  const resp = await fetchFn(url, { method: "GET" });

  if (!resp.ok) {
    throw new DiscoveryFetchError(
      resp.status,
      url,
      `CDP discovery returned HTTP ${resp.status} for ${url}`,
    );
  }

  let json: RawSearchResponse;
  try {
    json = await resp.json() as RawSearchResponse;
  } catch (e) {
    throw new DiscoveryFetchError(
      resp.status,
      url,
      `CDP discovery returned malformed JSON: ${(e as Error).message}`,
    );
  }

  const entries = json.resources ?? [];
  return entries.filter((e) =>
    e.accepts?.some((a) => a.network === params.network)
  );
}
