// Candidate source for the sanctioned denylist warm step (src/vetter/run.ts).
//
// The authoritative public list of sanctioned crypto addresses is the US
// Treasury OFAC SDN list. We consume the community mirror
// 0xB10C/ofac-sanctioned-digital-currency-addresses, which republishes it as
// clean per-asset JSON, regenerated nightly (0 UTC) via GitHub Actions. OFAC IS
// the authority (the Chainalysis on-chain oracle is itself OFAC-derived), so a
// fetched address is denylisted directly — no per-address RPC needed.
//
// On any fetch failure we fall back to the checked-in seed (data/sanctioned_
// seeds.json) so the warm step degrades gracefully and the test suite stays
// offline-safe.

import { log } from "../observability/log.ts";

const OFAC_ETH_URL =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json";
const SEED_PATH = new URL("../../data/sanctioned_seeds.json", import.meta.url);
const DEFAULT_TIMEOUT_MS = 10_000;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface SanctionedAddressSource {
  /** Deduplicated, lowercase, validated EVM addresses. */
  addresses: string[];
  /** Provenance: "ofac:0xB10C" on success, "local-seed" on fallback. */
  source: string;
}

export interface FetchOfacOpts {
  /** Test seam for the network fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam for the offline-seed read. Defaults to reading SEED_PATH. */
  readSeed?: () => Promise<string[]>;
  timeoutMs?: number;
}

async function defaultReadSeed(): Promise<string[]> {
  const raw = await Deno.readTextFile(SEED_PATH);
  const parsed = JSON.parse(raw) as { addresses?: unknown };
  return Array.isArray(parsed.addresses)
    ? parsed.addresses.filter((a): a is string => typeof a === "string")
    : [];
}

function normalize(addresses: string[]): string[] {
  const seen = new Set<string>();
  for (const a of addresses) {
    if (typeof a !== "string") continue;
    const lc = a.trim().toLowerCase();
    if (EVM_ADDRESS_RE.test(lc)) seen.add(lc);
  }
  return [...seen];
}

/**
 * Fetches the OFAC SDN ETH address list, falling back to the local seed on any
 * failure. Always returns at least the seed addresses (unless the seed read
 * also fails, in which case it returns whatever it has).
 */
export async function fetchOfacEthAddresses(
  opts: FetchOfacOpts = {},
): Promise<SanctionedAddressSource> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const readSeed = opts.readSeed ?? defaultReadSeed;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const resp = await fetchImpl(OFAC_ETH_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      throw new Error(`OFAC list fetch returned HTTP ${resp.status}`);
    }
    const json = await resp.json();
    if (!Array.isArray(json)) {
      throw new Error("OFAC list response was not a JSON array");
    }
    const addresses = normalize(json as string[]);
    if (addresses.length === 0) {
      throw new Error("OFAC list contained no valid ETH addresses");
    }
    return { addresses, source: "ofac:0xB10C" };
  } catch (e) {
    log.warn(
      `[ofac_list] live fetch failed, falling back to local seed: ${
        (e as Error).message
      }`,
    );
    try {
      return { addresses: normalize(await readSeed()), source: "local-seed" };
    } catch (seedErr) {
      log.error(
        `[ofac_list] local seed read also failed: ${
          (seedErr as Error).message
        }`,
      );
      return { addresses: [], source: "local-seed" };
    }
  }
}
