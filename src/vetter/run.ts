import { getDb } from "../db/client.ts";
import { log } from "../observability/log.ts";
import { type RecomputeResult, recomputeScores } from "../registry/score.ts";
import {
  fetchCandidates as defaultFetchCandidates,
  type FetchCandidatesOpts,
} from "../discovery/orchestrator.ts";
import type { Category, Chain } from "../agent/types.ts";
import {
  type CallShape,
  callShapeFromBazaarInfo,
  type DiscoveryEntry,
  extractBazaarInfo,
} from "../discovery/types.ts";
import {
  DEFAULT_DENYLIST_TTL_MS,
  type DenylistEntry,
  type SanctionedDenylist,
} from "../agent/sanctioned_denylist.ts";
import {
  fetchOfacEthAddresses,
  type SanctionedAddressSource,
} from "../agent/ofac_list.ts";
import { checkSanctionsOracle } from "../agent/sanctions_oracle.ts";

const PRICE_CEILING_USDC = 0.10;
const PRICE_BUMP_FACTOR = 1.20;
const PROBE_TIMEOUT_MS = 10_000;
const RECIPES_PATH = new URL("../../data/call_recipes.json", import.meta.url);
const BASE_NETWORK = "eip155:8453";
const ALL_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface RegistryRow {
  resource: string;
  price_usdc: string | null;
  status: string;
  source: string | null;
}

export interface ProbePriceResult {
  /** USDC price from the 402 response, or null if probe failed / service not 402. */
  maxAmountRequiredUsdc: number | null;
}

export interface VetterOpts {
  // DB seams
  fetchActiveAndProbation?: () => Promise<RegistryRow[]>;
  updatePrice?: (resource: string, priceUsdc: number) => Promise<void>;
  updateStatus?: (resource: string, status: string) => Promise<void>;
  insertCandidate?: (
    resource: string,
    category: string,
    priceUsdc: number,
    source: string | null,
    shape: CallShape,
  ) => Promise<boolean>;
  // Network seam
  probePrice?: (resource: string) => Promise<ProbePriceResult>;
  // File seam
  rewriteRecipePrice?: (
    serviceId: string | null,
    resource: string,
    newPrice: number,
  ) => Promise<void>;
  // Score seam
  runRecomputeScores?: typeof recomputeScores;
  // Discovery seam
  runFetchCandidates?: (
    categories: Category[],
    walletNetwork: "base" | "base-sepolia",
    opts?: FetchCandidatesOpts,
  ) => ReturnType<typeof defaultFetchCandidates>;
  skipDiscovery?: boolean;
}

export interface VetterResult {
  priceBumps: Array<{
    resource: string;
    oldPriceUsdc: number;
    newPriceUsdc: number;
  }>;
  probationMoves: Array<{ resource: string; reason: string }>;
  newCandidates: number;
  scoreResult: RecomputeResult;
}

// ── Default implementations ───────────────────────────────────────────────────

async function defaultFetchActiveAndProbation(): Promise<RegistryRow[]> {
  const db = getDb();
  return await db<RegistryRow[]>`
    SELECT resource, price_usdc::text AS price_usdc, status, source
    FROM service_registry
    WHERE status IN ('active', 'probation')
  `;
}

async function defaultUpdatePrice(
  resource: string,
  priceUsdc: number,
): Promise<void> {
  const db = getDb();
  await db`
    UPDATE service_registry
    SET price_usdc = ${priceUsdc},
        last_vetted_at = now(),
        updated_at = now()
    WHERE resource = ${resource}
  `;
}

async function defaultUpdateStatus(
  resource: string,
  status: string,
): Promise<void> {
  const db = getDb();
  await db`
    UPDATE service_registry
    SET status = ${status},
        last_vetted_at = now(),
        updated_at = now()
    WHERE resource = ${resource}
  `;
}

// jsonb columns: postgres.js sends a bare JS object as a Postgres array/record,
// not json — so serialize ourselves and cast. A null value passes through as
// SQL NULL (not the JSON literal `null`).
function jsonbParam(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

async function defaultInsertCandidate(
  resource: string,
  category: string,
  priceUsdc: number,
  source: string | null,
  shape: CallShape,
): Promise<boolean> {
  const db = getDb();
  const existing = await db<
    Array<{ id: string }>
  >`SELECT id FROM service_registry WHERE resource = ${resource}`;
  if (existing.length > 0) return false;
  await db`
    INSERT INTO service_registry
      (resource, category, price_usdc, status, source, score, last_vetted_at,
       method, query_params, path_params, body_schema, body_type)
    VALUES
      (${resource}, ${category}, ${priceUsdc}, 'probation', ${source}, 1.0, now(),
       ${shape.method},
       ${jsonbParam(shape.query_params)}::jsonb,
       ${jsonbParam(shape.path_params)}::jsonb,
       ${jsonbParam(shape.body_schema)}::jsonb,
       ${shape.body_type})
  `;
  return true;
}

/** Plain-GET probe: sends no payment header, expects a 402 with x402 body. */
async function defaultProbePrice(
  resource: string,
): Promise<ProbePriceResult> {
  try {
    const resp = await fetch(resource, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (resp.status !== 402) {
      await resp.body?.cancel();
      return { maxAmountRequiredUsdc: null };
    }
    const json = await resp.json() as {
      accepts?: Array<{
        // x402 implementations vary: some use `maxAmountRequired` (spec),
        // others use `amount` (Coinbase/CDP convention).
        maxAmountRequired?: string;
        amount?: string;
        network?: string;
      }>;
    };
    const accepts = json.accepts ?? [];
    const entry = accepts.find((a) => a.network === BASE_NETWORK) ??
      accepts[0];
    const amountStr = entry?.maxAmountRequired ?? entry?.amount;
    if (!amountStr) return { maxAmountRequiredUsdc: null };
    const micro = parseInt(amountStr, 10);
    if (isNaN(micro)) return { maxAmountRequiredUsdc: null };
    return { maxAmountRequiredUsdc: micro / 1_000_000 };
  } catch {
    return { maxAmountRequiredUsdc: null };
  }
}

async function defaultRewriteRecipePrice(
  serviceId: string | null,
  resource: string,
  newPrice: number,
): Promise<void> {
  const raw = await Deno.readTextFile(RECIPES_PATH);
  const all = JSON.parse(raw) as Record<
    string,
    { resource?: string; price_usdc?: number; [key: string]: unknown }
  >;

  let found = false;
  if (serviceId && all[serviceId]) {
    all[serviceId].price_usdc = newPrice;
    found = true;
  } else {
    for (const entry of Object.values(all)) {
      if (entry.resource === resource) {
        entry.price_usdc = newPrice;
        found = true;
        break;
      }
    }
  }

  if (!found) {
    log.warn(
      `[vetter] no recipe entry for resource=${resource} (source=${
        serviceId ?? "unknown"
      }) — call_recipes.json not updated`,
    );
    return;
  }

  await Deno.writeTextFile(RECIPES_PATH, JSON.stringify(all, null, 2) + "\n");
}

// ── Main vetter ───────────────────────────────────────────────────────────────

export async function runVetter(opts: VetterOpts = {}): Promise<VetterResult> {
  const fetchActiveAndProbation = opts.fetchActiveAndProbation ??
    defaultFetchActiveAndProbation;
  const updatePrice = opts.updatePrice ?? defaultUpdatePrice;
  const updateStatus = opts.updateStatus ?? defaultUpdateStatus;
  const insertCandidate = opts.insertCandidate ?? defaultInsertCandidate;
  const probePrice = opts.probePrice ?? defaultProbePrice;
  const rewriteRecipePrice = opts.rewriteRecipePrice ??
    defaultRewriteRecipePrice;
  const runRecomputeScoresFn = opts.runRecomputeScores ?? recomputeScores;
  const runFetchCandidates = opts.runFetchCandidates ?? defaultFetchCandidates;
  const skipDiscovery = opts.skipDiscovery ?? false;

  const priceBumps: VetterResult["priceBumps"] = [];
  const probationMoves: VetterResult["probationMoves"] = [];
  let newCandidates = 0;

  // ── 1. Price-probe every active/probation service ──────────────────────────
  const rows = await fetchActiveAndProbation();
  for (const row of rows) {
    const storedPrice = row.price_usdc != null ? parseFloat(row.price_usdc) : 0;
    const probe = await probePrice(row.resource);
    const realPrice = probe.maxAmountRequiredUsdc;

    if (realPrice === null || realPrice <= storedPrice) continue;

    if (realPrice > PRICE_CEILING_USDC) {
      // Above safety ceiling — put on probation for human review, no auto-bump.
      log.warn(
        `[vetter] price above ceiling for ${row.resource}: real=$${
          realPrice.toFixed(6)
        } > ceiling=$${PRICE_CEILING_USDC} — moving to probation`,
      );
      if (row.status !== "probation") {
        await updateStatus(row.resource, "probation");
      }
      probationMoves.push({
        resource: row.resource,
        reason: `real price $${
          realPrice.toFixed(6)
        } exceeds ceiling $${PRICE_CEILING_USDC}`,
      });
      continue;
    }

    // Auto-bump: new price = real × 1.20, rounded to 6 decimal places.
    const newPrice = Math.round(realPrice * PRICE_BUMP_FACTOR * 1_000_000) /
      1_000_000;
    log.info(
      `[vetter] price bump ${row.resource}: $${storedPrice} → $${newPrice} (real=$${realPrice})`,
    );
    await updatePrice(row.resource, newPrice);
    await rewriteRecipePrice(row.source, row.resource, newPrice);
    priceBumps.push({
      resource: row.resource,
      oldPriceUsdc: storedPrice,
      newPriceUsdc: newPrice,
    });
  }

  // ── 2. Discovery: insert unknown candidates as probation ───────────────────
  if (!skipDiscovery) {
    try {
      const result = await runFetchCandidates(ALL_CATEGORIES, "base");
      for (
        const [cat, entries] of Object.entries(result.candidates) as [
          Category,
          DiscoveryEntry[],
        ][]
      ) {
        for (const entry of entries) {
          const accept = entry.accepts.find((a) =>
            a.network === BASE_NETWORK
          ) ??
            entry.accepts[0];
          if (!accept) continue;
          const priceUsdc = parseInt(accept.amount, 10) / 1_000_000;
          // Snapshot the call shape from the provider's Bazaar hints so the
          // candidate is written invokable (W0.11). Without this the row would
          // be a dead "registry row with no recipe" that selection skips.
          const shape = callShapeFromBazaarInfo(extractBazaarInfo(entry));
          const added = await insertCandidate(
            entry.resource,
            cat,
            priceUsdc,
            null,
            shape,
          );
          if (added) {
            newCandidates++;
            log.info(
              `[vetter] new candidate: ${cat} ${entry.resource} @$${priceUsdc}`,
            );
          }
        }
      }
    } catch (e) {
      log.warn(`[vetter] discovery failed: ${(e as Error).message}`);
    }
  }

  // ── 3. Recompute scores + status transitions ───────────────────────────────
  const scoreResult = await runRecomputeScoresFn();

  return { priceBumps, probationMoves, newCandidates, scoreResult };
}

// ── Sanctioned denylist warm ($0) ───────────────────────────────────────────
//
// Pull the OFAC SDN ETH address list and write each entry to the long-TTL
// sanctioned denylist KV. Zero USDC, zero LLM, and (by default) zero RPC: OFAC
// is the source of truth, so addresses are denylisted directly. The optional
// crossCheck flag confirms each via the Chainalysis oracle before writing —
// off by default, since fanning out over hundreds of addresses risks public-RPC
// rate limits. The denylist self-bounds to |OFAC list|; TTL is the GC (each run
// re-asserts the current set, de-listed addresses age out). See
// src/agent/sanctioned_denylist.ts.

export interface WarmDenylistOpts {
  denylist: SanctionedDenylist;
  /** Test/override seam for the candidate source. Defaults to fetchOfacEthAddresses. */
  fetchAddresses?: () => Promise<SanctionedAddressSource>;
  /** Chain the verify pipeline reads the denylist under. Defaults to "eth". */
  chain?: Chain;
  ttlMs?: number;
  /** Confirm each address via the on-chain oracle before writing (off by default). */
  crossCheck?: boolean;
  /** Test seam for the oracle cross-check. Defaults to checkSanctionsOracle. */
  oracleCheckFn?: typeof checkSanctionsOracle;
}

export interface WarmDenylistResult {
  source: string;
  fetched: number;
  written: number;
  /** Addresses skipped because the oracle cross-check returned not-sanctioned. */
  skipped: number;
}

export async function warmSanctionedDenylist(
  opts: WarmDenylistOpts,
): Promise<WarmDenylistResult> {
  const chain = opts.chain ?? "eth";
  const fetchAddresses = opts.fetchAddresses ?? fetchOfacEthAddresses;
  const ttlMs = opts.ttlMs ?? DEFAULT_DENYLIST_TTL_MS;
  const oracleCheckFn = opts.oracleCheckFn ?? checkSanctionsOracle;

  const { addresses, source } = await fetchAddresses();
  const warmedAt = new Date().toISOString();
  let written = 0;
  let skipped = 0;

  for (const address of addresses) {
    if (opts.crossCheck) {
      try {
        const res = await oracleCheckFn(address, chain);
        if (!res.isSanctioned) {
          skipped++;
          continue;
        }
      } catch (e) {
        // RPC failure → trust the OFAC list rather than dropping the address.
        log.warn(
          `[vetter] denylist cross-check RPC failed for ${address} (writing anyway): ${
            (e as Error).message
          }`,
        );
      }
    }
    const entry: DenylistEntry = { reason: "OFAC SDN", source, warmedAt };
    await opts.denylist.set(chain, address, entry, ttlMs);
    written++;
  }

  log.info(
    `[vetter] denylist warm: source=${source} fetched=${addresses.length} written=${written} skipped=${skipped}`,
  );
  return { source, fetched: addresses.length, written, skipped };
}
