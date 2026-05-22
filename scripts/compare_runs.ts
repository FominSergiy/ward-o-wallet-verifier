// Compare two harness runs (v1 baseline vs v2 post-fixes) and emit a markdown
// comparison block. Reads both directories of per-address JSON files and
// computes the deltas on the metrics the v1 report flagged as targets.

interface RunFile {
  test: { address: string; label: string };
  metrics: {
    actualVerdict: string | null;
    actualConfidence: string | null;
    verdictMatch: string;
    primaryHits: number;
    alternateRescues: number;
    llmAdapterCount: number;
    hardErrors: number;
    totalSpentUsdc: number;
    latencyMs: number;
    resolved: string[];
    unresolved: string[];
  };
}

interface Aggregate {
  matches: number;
  partial: number;
  mismatch: number;
  errored: number;
  totalSpend: number;
  totalLatencyMs: number;
  totalReceipts: number;
  primary: number;
  alt: number;
  llm: number;
  errors: number;
  onchainResolvedCount: number;
}

const V1_DIR = "docs/real-wallet-tests/runs";
const V2_DIR = "docs/real-wallet-tests/runs_v2";
const OUT_PATH = "docs/real-wallet-tests/comparison.md";

function fmtPct(num: number, denom: number): string {
  if (denom === 0) return "n/a";
  return `${((num / denom) * 100).toFixed(0)}%`;
}

async function readRuns(dir: string): Promise<RunFile[]> {
  const runs: RunFile[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const raw = await Deno.readTextFile(`${dir}/${entry.name}`);
      runs.push(JSON.parse(raw) as RunFile);
    }
  } catch (e) {
    console.error(`Failed to read ${dir}: ${(e as Error).message}`);
  }
  return runs;
}

function aggregate(runs: RunFile[]): Aggregate {
  const matches = runs.filter((r) => r.metrics.verdictMatch === "match").length;
  const partial = runs.filter((r) => r.metrics.verdictMatch === "partial").length;
  const mismatch = runs.filter((r) => r.metrics.verdictMatch === "mismatch").length;
  const errored = runs.filter((r) => r.metrics.verdictMatch === "error").length;
  const totalSpend = runs.reduce((s, r) => s + r.metrics.totalSpentUsdc, 0);
  const totalLatencyMs = runs.reduce((s, r) => s + r.metrics.latencyMs, 0);
  const primary = runs.reduce((s, r) => s + r.metrics.primaryHits, 0);
  const alt = runs.reduce((s, r) => s + r.metrics.alternateRescues, 0);
  const llm = runs.reduce((s, r) => s + r.metrics.llmAdapterCount, 0);
  const errors = runs.reduce((s, r) => s + r.metrics.hardErrors, 0);
  const totalReceipts = primary + alt + errors;
  const onchainResolvedCount = runs.filter((r) =>
    r.metrics.resolved.includes("onchain_history")
  ).length;
  return {
    matches,
    partial,
    mismatch,
    errored,
    totalSpend,
    totalLatencyMs,
    totalReceipts,
    primary,
    alt,
    llm,
    errors,
    onchainResolvedCount,
  };
}

function delta(v1: number, v2: number, suffix = ""): string {
  const d = v2 - v1;
  if (Math.abs(d) < 1e-9) return `→ same (${v2.toFixed(2)}${suffix})`;
  const arrow = d > 0 ? "↑" : "↓";
  return `${v1.toFixed(2)}${suffix} ${arrow} ${v2.toFixed(2)}${suffix}`;
}

function deltaPct(v1Num: number, v1Den: number, v2Num: number, v2Den: number): string {
  if (v1Den === 0 || v2Den === 0) return "n/a";
  const p1 = (v1Num / v1Den) * 100;
  const p2 = (v2Num / v2Den) * 100;
  const arrow = p2 > p1 ? "↑" : p2 < p1 ? "↓" : "→";
  return `${p1.toFixed(0)}% ${arrow} ${p2.toFixed(0)}%`;
}

const v1 = await readRuns(V1_DIR);
const v2 = await readRuns(V2_DIR);
const a1 = aggregate(v1);
const a2 = aggregate(v2);

const lines: string[] = [];
lines.push("# v1 vs v2 Comparison — /verify-agent\n");
lines.push(`**Generated:** ${new Date().toISOString()}\n`);
lines.push(`v1 = pre-fix baseline (${v1.length} runs)`);
lines.push(`v2 = post-fix run (${v2.length} runs)\n`);

lines.push("## Headline metrics\n");
lines.push("| Metric | v1 | v2 | Delta | Target |");
lines.push("|---|---|---|---|---|");
lines.push(`| Verdict accuracy (strict match) | ${a1.matches}/${v1.length} | ${a2.matches}/${v2.length} | ${deltaPct(a1.matches, v1.length, a2.matches, v2.length)} | ≥ 5/5 |`);
lines.push(`| Primary-pick reliability | ${fmtPct(a1.primary, a1.totalReceipts)} | ${fmtPct(a2.primary, a2.totalReceipts)} | ${deltaPct(a1.primary, a1.totalReceipts, a2.primary, a2.totalReceipts)} | ≥ 70% |`);
lines.push(`| Alternate-rescue rate | ${fmtPct(a1.alt, a1.totalReceipts)} | ${fmtPct(a2.alt, a2.totalReceipts)} | ${deltaPct(a1.alt, a1.totalReceipts, a2.alt, a2.totalReceipts)} | (info) |`);
lines.push(`| LLM-adapter usage rate | ${fmtPct(a1.llm, a1.totalReceipts)} | ${fmtPct(a2.llm, a2.totalReceipts)} | ${deltaPct(a1.llm, a1.totalReceipts, a2.llm, a2.totalReceipts)} | ≤ 25% |`);
lines.push(`| Hard-error rate | ${fmtPct(a1.errors, a1.totalReceipts)} | ${fmtPct(a2.errors, a2.totalReceipts)} | ${deltaPct(a1.errors, a1.totalReceipts, a2.errors, a2.totalReceipts)} | (lower better) |`);
lines.push(`| onchain_history resolved | ${a1.onchainResolvedCount}/${v1.length} | ${a2.onchainResolvedCount}/${v2.length} | ${deltaPct(a1.onchainResolvedCount, v1.length, a2.onchainResolvedCount, v2.length)} | ≥ 4/5 |`);
lines.push(`| Total x402 spend (USDC) | $${a1.totalSpend.toFixed(4)} | $${a2.totalSpend.toFixed(4)} | ${delta(a1.totalSpend, a2.totalSpend, "$")} | similar |`);
lines.push(`| Total wall-clock | ${(a1.totalLatencyMs / 1000).toFixed(1)}s | ${(a2.totalLatencyMs / 1000).toFixed(1)}s | ${delta(a1.totalLatencyMs / 1000, a2.totalLatencyMs / 1000, "s")} | (info) |`);
lines.push(``);

lines.push("## Per-address comparison\n");
lines.push("| Address | Label | v1 verdict | v2 verdict | v1 ✓ | v2 ✓ |");
lines.push("|---|---|---|---|---|---|");

const symbol = (m: string) => m === "match" ? "✓" : m === "partial" ? "≈" : m === "error" ? "✗ err" : "✗";

const byAddr = new Map<string, { v1?: RunFile; v2?: RunFile }>();
for (const r of v1) {
  byAddr.set(r.test.address.toLowerCase(), {
    ...(byAddr.get(r.test.address.toLowerCase()) ?? {}),
    v1: r,
  });
}
for (const r of v2) {
  byAddr.set(r.test.address.toLowerCase(), {
    ...(byAddr.get(r.test.address.toLowerCase()) ?? {}),
    v2: r,
  });
}

for (const [_addr, pair] of byAddr) {
  const ref = pair.v2 ?? pair.v1;
  if (!ref) continue;
  const a = ref.test.address;
  lines.push(
    `| \`${a.slice(0, 8)}…${a.slice(-4)}\` | ${ref.test.label} | ${pair.v1?.metrics.actualVerdict ?? "—"} | ${pair.v2?.metrics.actualVerdict ?? "—"} | ${pair.v1 ? symbol(pair.v1.metrics.verdictMatch) : "—"} | ${pair.v2 ? symbol(pair.v2.metrics.verdictMatch) : "—"} |`,
  );
}
lines.push(``);

await Deno.writeTextFile(OUT_PATH, lines.join("\n") + "\n");
console.log(`Wrote ${OUT_PATH}`);
console.log(`v1: ${a1.matches}/${v1.length} match, $${a1.totalSpend.toFixed(4)} spend`);
console.log(`v2: ${a2.matches}/${v2.length} match, $${a2.totalSpend.toFixed(4)} spend`);
