// Throwaway: hit the two orbisapi services that v6 flagged as returning
// "only API metadata" with three real wallets, dump the raw response
// payloads to a markdown doc so we can decide whether the under-extraction
// happens client-side or whether the provider genuinely returns thin data.
//
// Usage:
//   ~/.deno/bin/deno run --allow-net --allow-env --allow-read --allow-write \
//     --env-file=.env scripts/inspect_orbis_responses.ts
//
// Expected cost: ~$0.03 (2 services × 3 wallets × ~$0.005).
// Output: docs/real-wallet-tests/orbis_raw_responses.md

import { agnicFetch, AgnicFetchError } from "../src/clients/agnic.ts";

interface Probe {
  serviceLabel: string;
  url: string;
  // We mirror the pattern adapter's default GET-with-?address= shape so we
  // see what the actual paid call returns. If the catalog wants POST, we'd
  // need to widen this — for the two services we're inspecting, the v6
  // receipts show they both succeed via GET via the pattern adapter.
  method: "GET";
}

interface Wallet {
  label: string;
  address: string;
  note: string;
}

const PROBES: Probe[] = [
  {
    serviceLabel: "labels (crypto-address-labeler-api-79be80)",
    url: "https://orbisapi.com/proxy/crypto-address-labeler-api-79be80",
    method: "GET",
  },
  {
    serviceLabel: "reputation (address-reputation-score-api-9d7eb2)",
    url: "https://orbisapi.com/proxy/address-reputation-score-api-9d7eb2",
    method: "GET",
  },
];

const WALLETS: Wallet[] = [
  {
    label: "Vitalik EOA",
    address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    note: "ENS-doxxed, no negative attribution expected",
  },
  {
    label: "Binance HW20",
    address: "0xf977814e90da44bfa03b6295a0616a897441acec",
    note: "Major institutional cold wallet — should surface 'Binance' label if provider knows it",
  },
  {
    label: "Lazarus EOA",
    address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96",
    note: "OFAC-sanctioned — should surface SDN / sanctions tag if provider knows it",
  },
];

interface ProbeResult {
  ok: boolean;
  data?: unknown;
  amountUsd?: number;
  paid?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

async function probe(p: Probe, w: Wallet): Promise<ProbeResult> {
  const targetUrl = `${p.url}?address=${encodeURIComponent(w.address)}`;
  try {
    const r = await agnicFetch(targetUrl, {
      method: p.method,
      // Service prices are catalog-side; we don't know exact, so cap at 1c
      // to avoid overpaying on any drift. The two services we hit are $0.005.
      maxValueUsd: 0.01,
    });
    return { ok: true, data: r.data, amountUsd: r.amountUsd, paid: r.paid };
  } catch (e) {
    if (e instanceof AgnicFetchError) {
      return { ok: false, errorCode: e.code, errorMessage: e.message };
    }
    return { ok: false, errorMessage: (e as Error).message };
  }
}

function inventoryFields(data: unknown, prefix = ""): string[] {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) {
    if (data.length === 0) return [`${prefix}[] (empty)`];
    return [`${prefix}[]`, ...inventoryFields(data[0], `${prefix}[0].`)];
  }
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const here = `${prefix}${k}`;
    if (v === null || v === undefined) {
      lines.push(`${here}: null`);
    } else if (Array.isArray(v)) {
      lines.push(`${here}: array(${v.length})`);
      if (v.length > 0 && typeof v[0] === "object") {
        lines.push(...inventoryFields(v[0], `${here}[0].`));
      }
    } else if (typeof v === "object") {
      lines.push(`${here}: object`);
      lines.push(...inventoryFields(v, `${here}.`));
    } else {
      const s = String(v);
      const preview = s.length > 60 ? `${s.slice(0, 60)}…` : s;
      lines.push(`${here}: ${typeof v} = ${preview}`);
    }
  }
  return lines;
}

async function main() {
  const outLines: string[] = [];
  outLines.push("# Orbisapi raw response inspection");
  outLines.push("");
  outLines.push(`**Date:** ${new Date().toISOString()}`);
  outLines.push("");
  outLines.push(
    "Captures of the two orbisapi services that v6 verdicts characterized " +
      'as "Label/Reputation provider returned only API metadata; no risk or ' +
      'safety labels are attached to this address."',
  );
  outLines.push("");
  outLines.push(
    "The goal: determine whether (a) the provider genuinely returns thin " +
      "data on these test addresses (provider gap), or (b) the synthesizer " +
      "is under-reading a populated field (extraction gap we can fix).",
  );
  outLines.push("");

  let totalSpend = 0;
  for (const p of PROBES) {
    outLines.push(`## ${p.serviceLabel}`);
    outLines.push("");
    outLines.push(`- URL pattern: \`${p.url}?address=…\``);
    outLines.push(`- Method: ${p.method}`);
    outLines.push("");
    for (const w of WALLETS) {
      console.log(`probe: ${p.serviceLabel} × ${w.label}`);
      const result = await probe(p, w);
      outLines.push(`### ${w.label} (\`${w.address}\`)`);
      outLines.push("");
      outLines.push(`*${w.note}*`);
      outLines.push("");
      if (result.ok) {
        totalSpend += result.amountUsd ?? 0;
        outLines.push(
          `Paid: \`${result.paid}\`, Amount: \`$${(result.amountUsd ?? 0).toFixed(4)}\``,
        );
        outLines.push("");
        outLines.push("**Field inventory:**");
        outLines.push("```");
        const inv = inventoryFields(result.data);
        if (inv.length === 0) {
          outLines.push("(empty)");
        } else {
          outLines.push(...inv);
        }
        outLines.push("```");
        outLines.push("");
        outLines.push("**Raw response:**");
        outLines.push("```json");
        outLines.push(JSON.stringify(result.data, null, 2));
        outLines.push("```");
      } else {
        outLines.push(`**FAILED** — code: \`${result.errorCode ?? "(none)"}\``);
        outLines.push("");
        outLines.push("```");
        outLines.push(result.errorMessage ?? "(no message)");
        outLines.push("```");
      }
      outLines.push("");
      // Brief delay between paid calls to be polite to the upstream.
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // ─── Pass 2: sub-endpoint probes ─────────────────────────────────────
  // Pass 1 revealed the root URL returns the service descriptor (endpoint
  // list, version), not actual address data. The descriptor declares
  // sub-paths like /label and /score — try them to confirm real data
  // lives one level deeper than what the pattern adapter currently calls.
  const SUB_PROBES: Array<{ label: string; url: string }> = [
    {
      label: "labels → /label sub-endpoint",
      url: "https://orbisapi.com/proxy/crypto-address-labeler-api-79be80/label",
    },
    {
      label: "reputation → /score sub-endpoint",
      url: "https://orbisapi.com/proxy/address-reputation-score-api-9d7eb2/score",
    },
  ];

  outLines.push("---");
  outLines.push("");
  outLines.push("## Pass 2 — Sub-endpoint probes");
  outLines.push("");
  outLines.push(
    "Pass 1 returned identical responses across all 3 wallets for both " +
      "services — the response is the service descriptor (a list of " +
      "available sub-endpoints), NOT label or score data. Below: probe the " +
      "documented sub-paths to see if address data lives one level deeper.",
  );
  outLines.push("");

  for (const sp of SUB_PROBES) {
    outLines.push(`### ${sp.label}`);
    outLines.push("");
    outLines.push(`URL: \`${sp.url}?address=…\``);
    outLines.push("");
    for (const w of WALLETS) {
      console.log(`sub-probe: ${sp.label} × ${w.label}`);
      const result = await probe({ serviceLabel: sp.label, url: sp.url, method: "GET" }, w);
      outLines.push(`#### ${w.label} (\`${w.address.slice(0, 10)}…\`)`);
      outLines.push("");
      if (result.ok) {
        totalSpend += result.amountUsd ?? 0;
        outLines.push(
          `Paid: \`${result.paid}\`, Amount: \`$${(result.amountUsd ?? 0).toFixed(4)}\``,
        );
        outLines.push("");
        outLines.push("```json");
        outLines.push(JSON.stringify(result.data, null, 2));
        outLines.push("```");
      } else {
        outLines.push(`**FAILED** — code: \`${result.errorCode ?? "(none)"}\``);
        outLines.push("");
        outLines.push("```");
        outLines.push(result.errorMessage ?? "(no message)");
        outLines.push("```");
      }
      outLines.push("");
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  outLines.push("---");
  outLines.push("");
  outLines.push(`**Total spend:** $${totalSpend.toFixed(4)}`);
  outLines.push("");
  outLines.push("## Analysis");
  outLines.push("");
  outLines.push(
    "(To be filled in after reviewing the raw payloads above. Key questions: " +
      "are entity/label/score fields actually populated for any of the three " +
      "wallets? If yes — which fields, and is the synthesizer prompt seeing " +
      "them? If no — what fields ARE populated, and can we steer the " +
      "synthesizer/query to providers that surface more substantive data?)",
  );
  outLines.push("");

  const outPath = "docs/real-wallet-tests/orbis_raw_responses.md";
  await Deno.writeTextFile(outPath, outLines.join("\n") + "\n");
  console.log(`\nWrote ${outPath}`);
  console.log(`Total spend: $${totalSpend.toFixed(4)}`);
}

await main();
