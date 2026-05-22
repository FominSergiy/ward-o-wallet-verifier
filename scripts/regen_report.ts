// Regenerate docs/real-wallet-tests/report.md from saved runs/*.json
// without re-running the API. Used when one run was patched offline.

interface RunFile {
  test: { address: string; label: string; expected: string; category: string; sourceUrl: string };
  metrics: {
    address: string;
    label: string;
    expected: string;
    actualVerdict: string | null;
    actualConfidence: string | null;
    verdictMatch: string;
    match: boolean;
    primaryHits: number;
    alternateRescues: number;
    llmAdapterCount: number;
    hardErrors: number;
    errorMessages: string[];
    totalSpentUsdc: number;
    latencyMs: number;
    resolved: string[];
    unresolved: string[];
    httpStatus: number;
    rawError?: string;
  };
  raw: unknown;
}

const RUNS_DIR = "docs/real-wallet-tests/runs";
const REPORT_PATH = "docs/real-wallet-tests/report.md";
const ENDPOINT = "http://localhost:8000/verify-agent";

function fmtPct(num: number, denom: number): string {
  if (denom === 0) return "n/a";
  return `${((num / denom) * 100).toFixed(0)}%`;
}

const runs: RunFile[] = [];
for await (const entry of Deno.readDir(RUNS_DIR)) {
  if (!entry.isFile || !entry.name.endsWith(".json")) continue;
  const raw = await Deno.readTextFile(`${RUNS_DIR}/${entry.name}`);
  runs.push(JSON.parse(raw) as RunFile);
}

// Order matches the original test set order
const order = [
  "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  "0xf977814e90da44bfa03b6295a0616a897441acec",
  "0x098b716b8aaf21512996dc57eb0615e2383e2f96",
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
  "0xa5e4b451d0a3c3d05fc3a8076fda45952b8f4f83",
];
runs.sort((a, b) =>
  order.indexOf(a.metrics.address.toLowerCase()) -
  order.indexOf(b.metrics.address.toLowerCase())
);

const lines: string[] = [];
lines.push("# Real-Wallet E2E Test Report — /verify-agent\n");
lines.push(`**Run at:** ${new Date().toISOString()}\n`);
lines.push(`**Endpoint:** \`${ENDPOINT}\`\n`);
lines.push(`**Total addresses:** ${runs.length}\n`);

const totalSpend = runs.reduce((s, r) => s + r.metrics.totalSpentUsdc, 0);
const totalLatency = runs.reduce((s, r) => s + r.metrics.latencyMs, 0);
const totalReceipts = runs.reduce(
  (s, r) =>
    s + r.metrics.primaryHits + r.metrics.alternateRescues + r.metrics.hardErrors,
  0,
);
const totalPrimary = runs.reduce((s, r) => s + r.metrics.primaryHits, 0);
const totalAlt = runs.reduce((s, r) => s + r.metrics.alternateRescues, 0);
const totalLlm = runs.reduce((s, r) => s + r.metrics.llmAdapterCount, 0);
const totalErrors = runs.reduce((s, r) => s + r.metrics.hardErrors, 0);
const matches = runs.filter((r) => r.metrics.verdictMatch === "match").length;
const partial = runs.filter((r) => r.metrics.verdictMatch === "partial").length;
const mismatch = runs.filter((r) => r.metrics.verdictMatch === "mismatch").length;
const errored = runs.filter((r) => r.metrics.verdictMatch === "error").length;

lines.push("## Aggregate metrics\n");
lines.push(`- **Total x402 spend:** $${totalSpend.toFixed(4)} USDC`);
lines.push(`- **Total wall-clock:** ${(totalLatency / 1000).toFixed(1)}s (sequential, 90s delay between runs to avoid upstream rate limits)`);
lines.push(
  `- **Verdict accuracy:** ${matches} match / ${partial} partial (insufficient_data) / ${mismatch} mismatch / ${errored} error → ${fmtPct(matches, runs.length)} strict match`,
);
lines.push(
  `- **Service-call outcomes:** ${totalPrimary} primary-hit / ${totalAlt} alternate-rescue / ${totalErrors} hard-error across ${totalReceipts} attempts`,
);
lines.push(
  `- **Primary-pick reliability:** ${fmtPct(totalPrimary, totalReceipts)} (% of LLM-rerank-chosen services that worked on first attempt)`,
);
lines.push(
  `- **Alternate-rescue rate:** ${fmtPct(totalAlt, totalReceipts)} (% of attempts resolved via runner-up service)`,
);
lines.push(
  `- **LLM-adapter usage:** ${fmtPct(totalLlm, totalReceipts)} (% of attempts that needed LLM-built call args)`,
);
lines.push(``);

lines.push("## Per-address summary\n");
lines.push(
  "| Address | Category | Expected | Actual | Conf | ✓/✗ | Primary | Alt rescue | LLM adapter | Errors | Spend | Latency |",
);
lines.push(
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
);
for (const r of runs) {
  const m = r.metrics;
  const verdictCol = m.actualVerdict ?? `(HTTP ${m.httpStatus})`;
  const matchSym = m.verdictMatch === "match"
    ? "✓"
    : m.verdictMatch === "partial"
    ? "≈"
    : m.verdictMatch === "error"
    ? "✗ err"
    : "✗";
  lines.push(
    `| \`${m.address.slice(0, 8)}…${m.address.slice(-4)}\` | ${m.label} | ${m.expected} | ${verdictCol} | ${m.actualConfidence ?? "-"} | ${matchSym} | ${m.primaryHits} | ${m.alternateRescues} | ${m.llmAdapterCount} | ${m.hardErrors} | $${m.totalSpentUsdc.toFixed(4)} | ${(m.latencyMs / 1000).toFixed(0)}s |`,
  );
}
lines.push(``);

// Per-service reliability
lines.push("## Per-service reliability\n");
const serviceStats = new Map<string, { ok: number; err: number }>();
for (const r of runs) {
  const raw = r.raw as { receipts?: Array<{ resource: string; status: string }> };
  if (!raw?.receipts) continue;
  for (const receipt of raw.receipts) {
    const s = serviceStats.get(receipt.resource) ?? { ok: 0, err: 0 };
    if (receipt.status === "ok" || receipt.status === "fallback_ok") s.ok++;
    else s.err++;
    serviceStats.set(receipt.resource, s);
  }
}
const sortedServices = [...serviceStats.entries()].sort((a, b) =>
  (b[1].ok + b[1].err) - (a[1].ok + a[1].err)
);
lines.push("| Service URL | OK | Error | Success rate |");
lines.push("|---|---|---|---|");
for (const [url, s] of sortedServices) {
  lines.push(
    `| \`${url}\` | ${s.ok} | ${s.err} | ${fmtPct(s.ok, s.ok + s.err)} |`,
  );
}
lines.push(``);

// Per-address detail
lines.push("## Per-address detail\n");
for (const r of runs) {
  const m = r.metrics;
  const raw = r.raw as {
    verdict?: { headline?: string; reasoning?: string };
  };
  lines.push(`### ${m.label}\n`);
  lines.push(`- **Address:** \`${m.address}\``);
  lines.push(`- **Chain:** \`${r.test.chain}\``);
  lines.push(`- **Expected:** \`${m.expected}\``);
  lines.push(
    `- **Actual:** \`${m.actualVerdict ?? `HTTP ${m.httpStatus}`}\` (confidence: \`${m.actualConfidence ?? "n/a"}\`)`,
  );
  if (raw?.verdict?.headline) {
    lines.push(`- **Headline:** ${raw.verdict.headline}`);
  }
  if (raw?.verdict?.reasoning) {
    lines.push(
      `- **Reasoning:** ${raw.verdict.reasoning.replace(/\n/g, " ")}`,
    );
  }
  lines.push(`- **Coverage:** resolved=[${m.resolved.join(", ") || "—"}] unresolved=[${m.unresolved.join(", ") || "—"}]`);
  if (m.errorMessages.length > 0) {
    lines.push(`- **Hard errors:**`);
    for (const e of m.errorMessages) lines.push(`  - ${e}`);
  }
  if (m.rawError) {
    lines.push(`- **Run error:** ${m.rawError}`);
  }
  lines.push(``);
}

lines.push("## Notes\n");
lines.push("- Raw responses for each address are saved under `docs/real-wallet-tests/runs/`.");
lines.push("- `partial` verdict means the route returned `insufficient_data` instead of the expected verdict — that's a more conservative miss than `safe_to_transact` when we expected `do_not_transact` (or vice versa).");
lines.push("");

await Deno.writeTextFile(REPORT_PATH, lines.join("\n") + "\n");
console.log(`Report regenerated: ${REPORT_PATH}`);
console.log(`Total spend across all runs: $${totalSpend.toFixed(4)}`);
console.log(`Verdict accuracy: ${matches}/${runs.length} match (${fmtPct(matches, runs.length)})`);
