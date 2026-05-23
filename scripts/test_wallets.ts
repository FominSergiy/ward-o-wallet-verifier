// Real-wallet e2e harness for POST /verify-agent.
// Runs each address against a locally-running dev server, captures the full
// response, computes operational metrics, and writes a markdown report.
//
// Usage:
//   ~/.deno/bin/deno task dev   # in another terminal
//   ~/.deno/bin/deno run --allow-net --allow-env --allow-read --allow-write \
//     scripts/test_wallets.ts

interface TestAddress {
  address: string;
  chain: string;
  label: string;
  category: string;
  expected: "safe_to_transact" | "do_not_transact" | "insufficient_data";
  sourceUrl: string;
}

const ADDRESSES: TestAddress[] = [
  {
    address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    chain: "eth",
    label: "Vitalik's main wallet (vitalik.eth)",
    category: "Safe / ENS-doxxed (EOA)",
    expected: "safe_to_transact",
    sourceUrl: "https://etherscan.io/address/0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  },
  {
    address: "0xf977814e90da44bfa03b6295a0616a897441acec",
    chain: "eth",
    label: "Binance Hot Wallet 20",
    category: "Verified exchange (EOA)",
    expected: "safe_to_transact",
    sourceUrl: "https://etherscan.io/address/0xf977814e90da44bfa03b6295a0616a897441acec",
  },
  {
    address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96",
    chain: "eth",
    label: "Lazarus Group (Ronin bridge hack)",
    category: "OFAC-sanctioned (North Korea, EOA)",
    expected: "do_not_transact",
    sourceUrl: "https://www.trmlabs.com/resources/blog/north-koreas-lazarus-group-moves-funds-through-tornado-cash",
  },
  {
    address: "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
    chain: "eth",
    label: "Tornado Cash router contract",
    category: "Mixer (smart contract)",
    expected: "do_not_transact",
    sourceUrl: "https://etherscan.io/address/0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
  },
];

const ENDPOINT = Deno.env.get("VERIFY_AGENT_URL") ??
  "http://localhost:8000/verify-agent";
const RUNS_DIR = Deno.env.get("OUTPUT_DIR") ?? "docs/real-wallet-tests/runs";
const REPORT_PATH = Deno.env.get("REPORT_PATH") ??
  "docs/real-wallet-tests/report.md";

interface Receipt {
  category: string;
  resource: string;
  status: "ok" | "fallback_ok" | "error";
  adapterPath: "pattern" | "llm";
  amountUsdc: number;
  durationMs: number;
  paid: boolean;
  error?: string;
}

interface PlanService {
  category: string;
  resource: string;
  priceUsdc: number;
  rationale: string;
}

interface VerifyAgentResponse {
  verdict: {
    address: string;
    chain: string;
    safe: boolean;
    verdict: string;
    confidence: string;
    headline: string;
    reasoning: string;
    findings: Array<{ category: string; severity: string; finding: string }>;
    coverage: {
      requested: string[];
      resolved: string[];
      unresolved: string[];
    };
    totalSpentUsdc: number;
    generatedAt: string;
  };
  plan: { services: PlanService[] };
  receipts: Receipt[];
  walletNetwork: string;
  totalSpentUsdc: number;
  // Set by route on error response:
  error?: string;
  message?: string;
}

interface RunMetrics {
  address: string;
  label: string;
  expected: string;
  actualVerdict: string | null;
  actualConfidence: string | null;
  verdictMatch: "match" | "mismatch" | "partial" | "error";
  match: boolean;
  primaryHits: number; // services where plan === receipt URL, status ok/fallback_ok
  alternateRescues: number; // ok via alternate
  llmAdapterCount: number; // adapterPath === "llm" regardless of status
  hardErrors: number; // status === "error"
  errorMessages: string[];
  totalSpentUsdc: number;
  latencyMs: number;
  resolved: string[];
  unresolved: string[];
  httpStatus: number;
  rawError?: string;
}

async function runOne(t: TestAddress): Promise<{
  metrics: RunMetrics;
  raw: VerifyAgentResponse | { error: string; status: number };
}> {
  console.log(`\n=== Running ${t.label} (${t.address}) on chain ${t.chain} ===`);
  const start = performance.now();
  let httpStatus = 0;
  let body: VerifyAgentResponse | null = null;
  let textBody = "";

  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: t.address, chain: t.chain }),
    });
    httpStatus = resp.status;
    textBody = await resp.text();
    try {
      body = JSON.parse(textBody) as VerifyAgentResponse;
    } catch {
      body = null;
    }
  } catch (e) {
    console.error(`  fetch failed:`, (e as Error).message);
    return {
      metrics: emptyMetrics(t, {
        httpStatus: 0,
        rawError: (e as Error).message,
        latencyMs: performance.now() - start,
      }),
      raw: { error: (e as Error).message, status: 0 },
    };
  }

  const latencyMs = performance.now() - start;
  console.log(`  HTTP ${httpStatus} in ${(latencyMs / 1000).toFixed(1)}s`);

  if (!body || httpStatus !== 200 || !body.verdict) {
    console.log(`  ERROR body: ${textBody.slice(0, 200)}`);
    return {
      metrics: emptyMetrics(t, {
        httpStatus,
        rawError: body?.message ?? body?.error ?? textBody.slice(0, 200),
        latencyMs,
      }),
      raw: body ?? { error: textBody, status: httpStatus },
    };
  }

  const metrics = computeMetrics(t, body, latencyMs, httpStatus);
  console.log(
    `  verdict=${metrics.actualVerdict} (expected=${t.expected}) match=${metrics.match}`,
  );
  console.log(
    `  primary=${metrics.primaryHits} alt-rescue=${metrics.alternateRescues} llm-adapter=${metrics.llmAdapterCount} errors=${metrics.hardErrors} spent=$${metrics.totalSpentUsdc.toFixed(4)}`,
  );
  return { metrics, raw: body };
}

function emptyMetrics(t: TestAddress, partial: Partial<RunMetrics>): RunMetrics {
  return {
    address: t.address,
    label: t.label,
    expected: t.expected,
    actualVerdict: null,
    actualConfidence: null,
    verdictMatch: "error",
    match: false,
    primaryHits: 0,
    alternateRescues: 0,
    llmAdapterCount: 0,
    hardErrors: 0,
    errorMessages: [],
    totalSpentUsdc: 0,
    latencyMs: 0,
    resolved: [],
    unresolved: [],
    httpStatus: 0,
    ...partial,
  };
}

function computeMetrics(
  t: TestAddress,
  body: VerifyAgentResponse,
  latencyMs: number,
  httpStatus: number,
): RunMetrics {
  const planByCategory = new Map(
    body.plan.services.map((s) => [s.category, s.resource]),
  );

  let primaryHits = 0;
  let alternateRescues = 0;
  let llmAdapterCount = 0;
  let hardErrors = 0;
  const errorMessages: string[] = [];

  for (const r of body.receipts) {
    const expectedResource = planByCategory.get(r.category);
    const okStatus = r.status === "ok" || r.status === "fallback_ok";
    if (okStatus && r.resource === expectedResource) primaryHits++;
    if (okStatus && r.resource !== expectedResource) alternateRescues++;
    if (r.adapterPath === "llm") llmAdapterCount++;
    if (r.status === "error") {
      hardErrors++;
      if (r.error) errorMessages.push(`[${r.category}] ${r.error}`);
    }
  }

  const actualVerdict = body.verdict.verdict;
  const match = actualVerdict === t.expected;
  // "partial" — for sanctioned/scam cases, insufficient_data is still
  // safer than the wrong direction (safe_to_transact). We mark these.
  const isPartial = !match && actualVerdict === "insufficient_data";

  return {
    address: t.address,
    label: t.label,
    expected: t.expected,
    actualVerdict,
    actualConfidence: body.verdict.confidence,
    verdictMatch: match ? "match" : isPartial ? "partial" : "mismatch",
    match,
    primaryHits,
    alternateRescues,
    llmAdapterCount,
    hardErrors,
    errorMessages,
    totalSpentUsdc: body.totalSpentUsdc,
    latencyMs,
    resolved: body.verdict.coverage.resolved,
    unresolved: body.verdict.coverage.unresolved,
    httpStatus,
  };
}

function fmtPct(num: number, denom: number): string {
  if (denom === 0) return "n/a";
  return `${((num / denom) * 100).toFixed(0)}%`;
}

function writeReport(results: { metrics: RunMetrics; raw: unknown }[]): string {
  const lines: string[] = [];

  lines.push("# Real-Wallet E2E Test Report — /verify-agent\n");
  lines.push(`**Run at:** ${new Date().toISOString()}\n`);
  lines.push(`**Endpoint:** \`${ENDPOINT}\`\n`);
  lines.push(
    `**Total addresses:** ${results.length}\n`,
  );

  const totalSpend = results.reduce((s, r) => s + r.metrics.totalSpentUsdc, 0);
  const totalLatency = results.reduce((s, r) => s + r.metrics.latencyMs, 0);
  const totalReceipts = results.reduce(
    (s, r) =>
      s + r.metrics.primaryHits + r.metrics.alternateRescues +
      r.metrics.hardErrors,
    0,
  );
  const totalPrimary = results.reduce((s, r) => s + r.metrics.primaryHits, 0);
  const totalAlt = results.reduce((s, r) => s + r.metrics.alternateRescues, 0);
  const totalLlm = results.reduce((s, r) => s + r.metrics.llmAdapterCount, 0);
  const totalErrors = results.reduce((s, r) => s + r.metrics.hardErrors, 0);
  const matches = results.filter((r) => r.metrics.verdictMatch === "match").length;
  const partial = results.filter((r) => r.metrics.verdictMatch === "partial").length;
  const mismatch = results.filter((r) => r.metrics.verdictMatch === "mismatch").length;
  const errored = results.filter((r) => r.metrics.verdictMatch === "error").length;

  lines.push("## Aggregate metrics\n");
  lines.push(`- **Total x402 spend:** $${totalSpend.toFixed(4)} USDC`);
  lines.push(`- **Total wall-clock:** ${(totalLatency / 1000).toFixed(1)}s (sequential)`);
  lines.push(
    `- **Verdict accuracy:** ${matches} match / ${partial} partial (insufficient_data) / ${mismatch} mismatch / ${errored} error → ${fmtPct(matches, results.length)} strict match`,
  );
  lines.push(
    `- **Service-call outcomes:** ${totalPrimary} primary-hit / ${totalAlt} alternate-rescue / ${totalErrors} hard-error across ${totalReceipts} attempts`,
  );
  lines.push(
    `- **Primary-pick reliability:** ${fmtPct(totalPrimary, totalReceipts)} (% of LLM-rerank-chosen services that worked on first attempt)`,
  );
  lines.push(
    `- **Alternate-rescue rate:** ${fmtPct(totalAlt, totalReceipts)} (% of resolved services that came from runner-ups)`,
  );
  lines.push(
    `- **LLM-adapter usage:** ${fmtPct(totalLlm, totalReceipts)} (% of attempts that needed LLM-built call args)`,
  );
  lines.push(``);

  // Per-address summary table
  lines.push("## Per-address summary\n");
  lines.push(
    "| Address | Category | Expected | Actual | Conf | ✓/✗ | Primary | Alt rescue | LLM adapter | Errors | Spend | Latency |",
  );
  lines.push(
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of results) {
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
  for (const r of results) {
    const raw = r.raw as VerifyAgentResponse;
    if (!raw?.receipts) continue;
    for (const receipt of raw.receipts) {
      const s = serviceStats.get(receipt.resource) ??
        { ok: 0, err: 0 };
      if (receipt.status === "ok" || receipt.status === "fallback_ok") s.ok++;
      else s.err++;
      serviceStats.set(receipt.resource, s);
    }
  }
  const sortedServices = [...serviceStats.entries()].sort((a, b) => {
    const totalA = a[1].ok + a[1].err;
    const totalB = b[1].ok + b[1].err;
    return totalB - totalA;
  });
  lines.push("| Service URL | OK | Error | Success rate |");
  lines.push("|---|---|---|---|");
  for (const [url, s] of sortedServices) {
    lines.push(
      `| \`${url}\` | ${s.ok} | ${s.err} | ${fmtPct(s.ok, s.ok + s.err)} |`,
    );
  }
  lines.push(``);

  // Per-address detail with errors + verdict reasoning
  lines.push("## Per-address detail\n");
  for (const r of results) {
    const m = r.metrics;
    const raw = r.raw as VerifyAgentResponse;
    lines.push(`### ${m.label}\n`);
    lines.push(`- **Address:** \`${m.address}\``);
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
  lines.push(
    "- Raw responses for each address are saved under `docs/real-wallet-tests/runs/`.",
  );
  lines.push(
    "- `partial` verdict means the route returned `insufficient_data` instead of the expected verdict — that's a more conservative miss than `safe_to_transact` when we expected `do_not_transact` (or vice versa).",
  );

  return lines.join("\n") + "\n";
}

async function main() {
  console.log(`Endpoint: ${ENDPOINT}`);

  // Sanity check: server is up
  try {
    const health = await fetch(ENDPOINT.replace("/verify-agent", "/health"));
    if (health.status !== 200) {
      console.error(`Server /health returned ${health.status} — is dev server running?`);
      Deno.exit(1);
    }
    console.log(`Server /health OK\n`);
  } catch (e) {
    console.error(`Cannot reach server: ${(e as Error).message}`);
    console.error(`Start it with: ~/.deno/bin/deno task dev`);
    Deno.exit(1);
  }

  await Deno.mkdir(RUNS_DIR, { recursive: true });

  const results: { metrics: RunMetrics; raw: unknown }[] = [];
  const INTER_CALL_DELAY_MS = 90_000; // avoid rate-limiting upstream services
  for (let i = 0; i < ADDRESSES.length; i++) {
    const t = ADDRESSES[i];
    const r = await runOne(t);
    results.push(r);
    const filename = `${RUNS_DIR}/${t.address.toLowerCase()}.json`;
    await Deno.writeTextFile(
      filename,
      JSON.stringify({ test: t, metrics: r.metrics, raw: r.raw }, null, 2),
    );
    console.log(`  Saved: ${filename}`);
    if (i < ADDRESSES.length - 1) {
      console.log(`  ...waiting ${INTER_CALL_DELAY_MS / 1000}s before next address...`);
      await new Promise((res) => setTimeout(res, INTER_CALL_DELAY_MS));
    }
  }

  const report = writeReport(results);
  await Deno.writeTextFile(REPORT_PATH, report);
  console.log(`\nReport: ${REPORT_PATH}`);
  console.log(
    `Total spent across all runs: $${results.reduce((s, r) => s + r.metrics.totalSpentUsdc, 0).toFixed(4)}`,
  );
}

await main();
