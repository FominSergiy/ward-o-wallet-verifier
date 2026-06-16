// Benchmark script — runs the full fixture suite end-to-end against real
// services and writes a structured JSON baseline file.
//
// Usage: ~/.deno/bin/deno task benchmark
// Output: benchmarks/v8-baseline.json

import { WALLET_FIXTURES } from "../src/fixtures/wallets.ts";
import { verifyAgent } from "../src/agent/verify.ts";
import type {
  PhaseEvent,
  ServiceEvent,
  VerifyEvent,
} from "../src/agent/events.ts";
import type { Verdict } from "../src/agent/verdict.ts";

const OUTPUT_PATH = Deno.env.get("BENCHMARK_OUTPUT") ??
  "benchmarks/v8-baseline.json";
const INTER_CALL_DELAY_MS = 90_000;

// --- types ---

interface PhaseTiming {
  duration_ms: number;
}

interface ServiceCost {
  resource: string;
  category: string;
  cost_usd: number;
}

interface WalletResult {
  address: string;
  label: string;
  expected: Verdict;
  verdict: Verdict | null;
  accuracy_match: boolean;
  duration_ms: number;
  phases: {
    discover?: PhaseTiming;
    invoke?: PhaseTiming;
    synthesize?: PhaseTiming;
  };
  services: ServiceCost[];
  total_cost_usd: number;
  error?: string;
}

interface AggregateStats {
  accuracy: { correct: number; total: number; label: string };
  latency_ms: { p50: number; p95: number; mean: number };
  cost_usd: { mean: number; p95: number; total: number };
}

interface BaselineOutput {
  generated_at: string;
  fixture_version: "v8";
  wallets: WalletResult[];
  aggregate: AggregateStats;
}

// --- helpers ---

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function computeAggregate(wallets: WalletResult[]): AggregateStats {
  const correct = wallets.filter((w) => w.accuracy_match).length;
  const latencies = [...wallets.map((w) => w.duration_ms)].sort((a, b) =>
    a - b
  );
  const costs = [...wallets.map((w) => w.total_cost_usd)].sort((a, b) => a - b);
  const meanLatency = latencies.reduce((s, v) => s + v, 0) /
    (latencies.length || 1);
  const meanCost = costs.reduce((s, v) => s + v, 0) / (costs.length || 1);
  const totalCost = costs.reduce((s, v) => s + v, 0);

  return {
    accuracy: {
      correct,
      total: wallets.length,
      label: `${correct}/${wallets.length}`,
    },
    latency_ms: {
      mean: Math.round(meanLatency),
      p50: Math.round(percentile(latencies, 50)),
      p95: Math.round(percentile(latencies, 95)),
    },
    cost_usd: {
      mean: parseFloat(meanCost.toFixed(6)),
      p95: parseFloat(percentile(costs, 95).toFixed(6)),
      total: parseFloat(totalCost.toFixed(6)),
    },
  };
}

// --- core runner ---

async function runOne(
  fixture: (typeof WALLET_FIXTURES)[number],
): Promise<WalletResult> {
  const phaseStarts = new Map<string, number>();
  const phaseDurations: WalletResult["phases"] = {};
  const services: ServiceCost[] = [];

  const onEvent = (e: VerifyEvent) => {
    if (e.type === "phase") {
      const pe = e as PhaseEvent;
      if (pe.status === "start") {
        phaseStarts.set(pe.phase, Date.now());
      } else {
        const start = phaseStarts.get(pe.phase);
        if (start !== undefined) {
          (phaseDurations as Record<string, PhaseTiming>)[pe.phase] = {
            duration_ms: Date.now() - start,
          };
        }
      }
    }
    if (e.type === "service" && e.status === "ok") {
      const se = e as ServiceEvent;
      if (se.amountUsdc !== undefined && se.amountUsdc > 0) {
        services.push({
          resource: se.resource,
          category: se.category as string,
          cost_usd: se.amountUsdc,
        });
      }
    }
  };

  const wallStart = Date.now();
  let verdict: Verdict | null = null;
  let error: string | undefined;
  let totalCostUsd = 0;

  try {
    console.log(`  running ${fixture.label} (${fixture.address})`);
    const result = await verifyAgent(
      { address: fixture.address },
      { onEvent },
    );
    verdict = result.verdict.verdict;
    totalCostUsd = result.totalSpentUsdc;
  } catch (e) {
    error = (e as Error).message;
    console.error(`  ERROR: ${error}`);
  }

  const duration_ms = Date.now() - wallStart;
  const accuracy_match = verdict === fixture.expected;

  console.log(
    `  verdict=${
      verdict ?? "null"
    } expected=${fixture.expected} match=${accuracy_match} ` +
      `cost=$${totalCostUsd.toFixed(4)} latency=${
        (duration_ms / 1000).toFixed(1)
      }s`,
  );

  return {
    address: fixture.address,
    label: fixture.label,
    expected: fixture.expected,
    verdict,
    accuracy_match,
    duration_ms,
    phases: phaseDurations,
    services,
    total_cost_usd: totalCostUsd,
    ...(error ? { error } : {}),
  };
}

async function main() {
  console.log(`\n=== Ward-O Benchmark (v8 fixture suite) ===`);
  console.log(`Fixtures: ${WALLET_FIXTURES.length}`);
  console.log(`Output: ${OUTPUT_PATH}\n`);

  await Deno.mkdir("benchmarks", { recursive: true });

  const wallets: WalletResult[] = [];

  for (let i = 0; i < WALLET_FIXTURES.length; i++) {
    const fixture = WALLET_FIXTURES[i];
    console.log(`\n[${i + 1}/${WALLET_FIXTURES.length}] ${fixture.label}`);
    const result = await runOne(fixture);
    wallets.push(result);

    if (i < WALLET_FIXTURES.length - 1) {
      console.log(
        `  ...waiting ${INTER_CALL_DELAY_MS / 1000}s before next wallet...`,
      );
      await new Promise((res) => setTimeout(res, INTER_CALL_DELAY_MS));
    }
  }

  const aggregate = computeAggregate(wallets);

  const output: BaselineOutput = {
    generated_at: new Date().toISOString(),
    fixture_version: "v8",
    wallets,
    aggregate,
  };

  await Deno.writeTextFile(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\n=== Results ===`);
  console.log(`Accuracy:  ${aggregate.accuracy.label} correct`);
  console.log(`P50 latency: ${aggregate.latency_ms.p50}ms`);
  console.log(`P95 latency: ${aggregate.latency_ms.p95}ms`);
  console.log(`Mean cost:   $${aggregate.cost_usd.mean.toFixed(4)}`);
  console.log(`P95 cost:    $${aggregate.cost_usd.p95.toFixed(4)}`);
  console.log(`Total cost:  $${aggregate.cost_usd.total.toFixed(4)}`);
  console.log(`\nBaseline written to: ${OUTPUT_PATH}`);

  const incorrect = wallets.filter((w) => !w.accuracy_match);
  if (incorrect.length > 0) {
    console.log(`\nMismatches:`);
    for (const w of incorrect) {
      console.log(
        `  ${w.label}: expected=${w.expected} got=${w.verdict ?? "null"}${
          w.error ? ` (error: ${w.error})` : ""
        }`,
      );
    }
  }
}

await main();
