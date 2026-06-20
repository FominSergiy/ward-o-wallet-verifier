// Manual trigger for the background vetter job.
// Runs the same logic as the scheduled cron — price-probe active/probation
// services, discover new candidates, recompute scores.
//
//   DATABASE_URL=<url> AGNIC_API_KEY=<key> ~/.deno/bin/deno run \
//     --allow-net --allow-env --allow-read --allow-write \
//     scripts/vet.ts

import { closeDb } from "../src/db/client.ts";
import { runVetter } from "../src/vetter/run.ts";

// Log the target host (never the credentials) so the scheduled-cron Actions log
// makes it obvious which Neon branch the vetter wrote to — dev vs prod is the
// environment, not the code.
const dbUrl = Deno.env.get("DATABASE_URL");
console.log(
  dbUrl
    ? `vetting against ${
      (() => {
        try {
          return new URL(dbUrl).host;
        } catch {
          return "<unparseable DATABASE_URL>";
        }
      })()
    }`
    : "DATABASE_URL unset — DB layer is a no-op, vetter writes will be dropped",
);

try {
  const result = await runVetter();

  console.log("\n── Vetter summary ──────────────────────────────────────────");
  console.log(`Price bumps:    ${result.priceBumps.length}`);
  for (const b of result.priceBumps) {
    console.log(`  ${b.resource}`);
    console.log(`    $${b.oldPriceUsdc} → $${b.newPriceUsdc}`);
  }

  console.log(`Probation moves: ${result.probationMoves.length}`);
  for (const m of result.probationMoves) {
    console.log(`  ${m.resource}: ${m.reason}`);
  }

  console.log(`New candidates: ${result.newCandidates}`);
  console.log(
    `Score updates:  ${result.scoreResult.updated} (${result.scoreResult.transitions.length} transitions)`,
  );
  for (const t of result.scoreResult.transitions) {
    console.log(`  ${t.resource}: ${t.from} → ${t.to}`);
  }
} finally {
  // Close the cached postgres.js pool so the open connections don't keep Deno's
  // event loop alive — otherwise this one-shot cron hangs after printing the
  // summary until the runner times out.
  await closeDb();
}
