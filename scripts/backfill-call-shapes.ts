// One-time backfill (W0.11): populate the service_registry call-shape columns
// (method, query_params, path_params, body_schema, body_type) for rows that
// pre-date 0003_service_registry_call_shapes.sql — i.e. the discovered
// probation candidates the vetter inserted with no shape, which selection now
// reads from the DB instead of call_recipes.json.
//
// It re-runs the SAME discovery the vetter uses (fetchCandidates over every
// category) and UPDATEs each matching registry row by resource with the shape
// derived from the provider's Bazaar input hints — the discovery equivalent of
// snapshot-recipes.ts, writing to the DB instead of the file.
//
// Idempotent: re-running just rewrites the same shapes. `blocked` rows are left
// untouched (they're never selected). Requires DATABASE_URL + AGNIC_API_KEY.
//
//   DATABASE_URL=<neon-url> ~/.deno/bin/deno run \
//     --allow-net --allow-env --allow-read scripts/backfill-call-shapes.ts
//
// Add --dry-run to print the planned UPDATEs without writing.

import { getDb } from "../src/db/client.ts";
import { fetchCandidates } from "../src/discovery/orchestrator.ts";
import {
  callShapeFromBazaarInfo,
  extractBazaarInfo,
} from "../src/discovery/types.ts";
import type { Category } from "../src/agent/types.ts";

const ALL_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
];

const dryRun = Deno.args.includes("--dry-run");

const url = Deno.env.get("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL is required");
  Deno.exit(1);
}
if (!Deno.env.get("AGNIC_API_KEY")) {
  console.error("AGNIC_API_KEY is required (discovery fan-out)");
  Deno.exit(1);
}

// jsonb columns: serialize ourselves and cast (see vetter/run.ts jsonbParam).
function jsonbParam(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

const db = getDb();

console.log(
  `[backfill] discovering candidates for ${ALL_CATEGORIES.join(", ")} …`,
);
const { candidates } = await fetchCandidates(ALL_CATEGORIES, "base");

let matched = 0;
let updated = 0;
const seenResources = new Set<string>();

for (const [cat, entries] of Object.entries(candidates)) {
  for (const entry of entries ?? []) {
    if (seenResources.has(entry.resource)) continue;
    seenResources.add(entry.resource);

    const shape = callShapeFromBazaarInfo(extractBazaarInfo(entry));
    // Only touch existing, non-blocked rows — discovery surfaces services we may
    // not have a registry row for, and we must never resurrect a blocked one.
    const rows = await db<Array<{ resource: string; status: string }>>`
      SELECT resource, status FROM service_registry
      WHERE resource = ${entry.resource} AND status <> 'blocked'
    `;
    if (rows.length === 0) continue;
    matched++;

    if (dryRun) {
      console.log(
        `[backfill] would update [${cat}] ${entry.resource} → method=${shape.method} ` +
          `query=${jsonbParam(shape.query_params) ?? "—"} ` +
          `path=${jsonbParam(shape.path_params) ?? "—"} ` +
          `body=${jsonbParam(shape.body_schema) ?? "—"} bodyType=${
            shape.body_type ?? "—"
          }`,
      );
      continue;
    }

    await db`
      UPDATE service_registry SET
        method       = ${shape.method},
        query_params = ${jsonbParam(shape.query_params)}::jsonb,
        path_params  = ${jsonbParam(shape.path_params)}::jsonb,
        body_schema  = ${jsonbParam(shape.body_schema)}::jsonb,
        body_type    = ${shape.body_type},
        updated_at   = now()
      WHERE resource = ${entry.resource} AND status <> 'blocked'
    `;
    updated++;
    console.log(
      `[backfill] updated [${cat}] ${entry.resource} (method=${shape.method})`,
    );
  }
}

// Report rows that still lack a method so the coverage gap is visible (e.g. a
// candidate that no longer appears in discovery).
const stillMissing = await db<Array<{ resource: string; status: string }>>`
  SELECT resource, status FROM service_registry
  WHERE status <> 'blocked' AND method IS NULL
`;

console.log(
  `[backfill] ${
    dryRun ? "(dry-run) " : ""
  }matched ${matched} registry row(s), ` +
    `updated ${updated}.`,
);
if (stillMissing.length > 0) {
  console.warn(
    `[backfill] ${stillMissing.length} non-blocked row(s) still have method IS NULL ` +
      `(not surfaced by this discovery run):`,
  );
  for (const r of stillMissing) console.warn(`  - [${r.status}] ${r.resource}`);
} else {
  console.log(`[backfill] all non-blocked rows now have a call shape.`);
}

await db.end();
