// Manual trigger for the background vetter job.
// Runs the same logic as the scheduled cron — price-probe active/probation
// services, discover new candidates, recompute scores.
//
//   DATABASE_URL=<url> AGNIC_API_KEY=<key> ~/.deno/bin/deno run \
//     --allow-net --allow-env --allow-read --allow-write \
//     scripts/vet.ts

import { runVetter } from "../src/vetter/run.ts";

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
