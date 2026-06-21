// Warm the sanctioned denylist from the OFAC SDN list. $0 — no x402, no LLM,
// and (unless DENYLIST_CROSS_CHECK=1) no RPC.
//
//   ~/.deno/bin/deno run --unstable-kv \
//     --allow-net --allow-env --allow-read --allow-write \
//     scripts/warm-denylist.ts
//
// KV TARGET: by default Deno.openKv() opens a LOCAL KV. To populate the
// production (Deno Deploy) KV from outside Deploy — e.g. the GitHub Actions cron
// — set DENO_KV_CONNECT_URL to the database connect URL and DENO_KV_ACCESS_TOKEN
// to a Deploy access token (KV Connect). When unset, this warms the local KV
// (useful for the verification dry-run and local dev).

import { denoKvDenylist } from "../src/agent/sanctioned_denylist.ts";
import { warmSanctionedDenylist } from "../src/vetter/run.ts";

const connectUrl = Deno.env.get("DENO_KV_CONNECT_URL");
const crossCheck = Deno.env.get("DENYLIST_CROSS_CHECK") === "1";

console.log(
  connectUrl
    ? `warming denylist against KV Connect: ${
      (() => {
        try {
          return new URL(connectUrl).host;
        } catch {
          return "<unparseable DENO_KV_CONNECT_URL>";
        }
      })()
    }`
    : "DENO_KV_CONNECT_URL unset — warming LOCAL KV (prod KV will NOT be populated)",
);

const kv = connectUrl ? await Deno.openKv(connectUrl) : await Deno.openKv();
try {
  const result = await warmSanctionedDenylist({
    denylist: denoKvDenylist(kv),
    crossCheck,
  });
  console.log("\n── Denylist warm summary ───────────────────────────────────");
  console.log(`Source:   ${result.source}`);
  console.log(`Fetched:  ${result.fetched}`);
  console.log(`Written:  ${result.written}`);
  console.log(`Skipped:  ${result.skipped}`);
} finally {
  kv.close();
}
