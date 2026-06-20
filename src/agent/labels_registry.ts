// HARDCODED-URL SUPPLEMENT: eth-labels.com labels registry.
//
// Hits a single, well-known public endpoint that mirrors the Etherscan
// label cloud (~170k addresses across 8 EVM chains, served by the
// `dawsbot/eth-labels` project). Free, no API key, no commercial relationship.
//
// Why this exists alongside x402 self-discovery (and isn't replacing it):
//   - The Bazaar catalog has no labeler today that knows top-N CEX hot
//     wallets (Coinbase 1, Kraken 4, Binance HW20). The v7 e2e run pinned
//     these at safe_to_transact/medium because synthesis had no entity
//     attribution to promote them. See docs/real-wallet-tests/report_v7.md.
//   - This module supplements — never replaces — the x402 labels call.
//     verify.ts merges the result into findings.labels under a `registry`
//     key alongside the x402 result (same pattern the Chainalysis oracle
//     uses for findings.sanctions). Opus weighs both.
//   - Failure is non-blocking: timeout / non-200 / malformed body throws
//     and the caller swallows. Self-discovery still produces a verdict.

import type { Chain } from "./types.ts";
import { getKv, type KvStore } from "../cache/kv.ts";

export const ETH_LABELS_BASE_URL = "https://eth-labels.com";
const DEFAULT_TIMEOUT_MS = 5_000;

const ETH_LABELS_CACHE_TTL_MS = parseInt(
  Deno.env.get("ETH_LABELS_CACHE_TTL_MS") ?? "86400000",
  10,
);

export interface RegistryLabel {
  address: string;
  label: string;
  nameTag: string | null;
  chainId: number;
}

export interface RegistryResult {
  source: "eth_labels_registry";
  endpoint: string;
  address: string;
  chain: Chain;
  labels: RegistryLabel[];
  checkedAt: string;
}

export class LabelsRegistryError extends Error {
  constructor(message: string, public readonly underlying?: unknown) {
    super(message);
    this.name = "LabelsRegistryError";
  }
}

export interface FetchLabelsRegistryOpts {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** KV store override for tests (skips the global singleton). */
  cache?: KvStore;
}

export async function fetchLabelsRegistry(
  address: string,
  chain: Chain,
  opts: FetchLabelsRegistryOpts = {},
): Promise<RegistryResult> {
  const cache = opts.cache ?? await getKv();
  const cacheKey = `eth_labels:${address.toLowerCase()}`;
  const cached = await cache.get<RegistryResult>(cacheKey);
  if (cached) return cached;

  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = `${ETH_LABELS_BASE_URL}/labels/${address}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetcher(endpoint, { signal: controller.signal });
  } catch (e) {
    throw new LabelsRegistryError(
      `eth-labels fetch failed: ${(e as Error).message}`,
      e,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new LabelsRegistryError(
      `eth-labels HTTP ${resp.status} ${resp.statusText}`,
    );
  }

  const body = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new LabelsRegistryError(
      `eth-labels response not JSON (first 120 chars: ${body.slice(0, 120)})`,
      e,
    );
  }

  // Endpoint returns an array of label entries on success, or
  // {"error": "..."} on a rejected input (e.g. malformed address).
  if (
    parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    "error" in parsed
  ) {
    throw new LabelsRegistryError(
      `eth-labels rejected request: ${(parsed as { error: string }).error}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new LabelsRegistryError(
      `eth-labels returned unexpected shape (expected array, got ${typeof parsed})`,
    );
  }

  const labels: RegistryLabel[] = parsed
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object"
    )
    .map((entry) => ({
      address: typeof entry.address === "string" ? entry.address : address,
      label: typeof entry.label === "string" ? entry.label : "",
      nameTag: typeof entry.nameTag === "string" ? entry.nameTag : null,
      chainId: typeof entry.chainId === "number" ? entry.chainId : -1,
    }))
    .filter((entry) => entry.label.length > 0);

  const result: RegistryResult = {
    source: "eth_labels_registry",
    endpoint,
    address,
    chain,
    labels,
    checkedAt: new Date().toISOString(),
  };

  await cache.set(cacheKey, result, ETH_LABELS_CACHE_TTL_MS);
  return result;
}
