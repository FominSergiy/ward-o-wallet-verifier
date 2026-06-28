import { assertEquals } from "@std/assert";
import { ServiceStatus } from "../db/enums.ts";
import {
  computeScore,
  nextStatus,
  recomputeScores,
  type WindowMetrics,
} from "./score.ts";

// ── computeScore ──────────────────────────────────────────────────────────────

Deno.test("computeScore: no observations returns 1.0 (default)", () => {
  const score = computeScore({
    resource: "https://x.example",
    total: 0,
    successes: 0,
    p95LatencyMs: null,
    emptyOnRich: 0,
  });
  assertEquals(score, 1.0);
});

Deno.test("computeScore: 0% failure + low latency yields near-maximum score", () => {
  const score = computeScore({
    resource: "https://good.example",
    total: 100,
    successes: 100,
    p95LatencyMs: 300,
    emptyOnRich: 0,
  });
  // reliability=1.0, latency=0.99, coverage=1.0 → weighted ≈ 0.9975
  assertEquals(score > 0.99, true);
});

Deno.test("computeScore: 80% failure rate yields low score", () => {
  const score = computeScore({
    resource: "https://bad.example",
    total: 100,
    successes: 20,
    p95LatencyMs: 5_000,
    emptyOnRich: 0,
  });
  // reliability=0.2, latency=0.833, coverage=1.0 → weighted ≈ 0.33
  assertEquals(score < 0.5, true);
});

Deno.test("computeScore: null latency treated as perfect latency", () => {
  const withNull = computeScore({
    resource: "https://x.example",
    total: 10,
    successes: 10,
    p95LatencyMs: null,
    emptyOnRich: 0,
  });
  const withZero = computeScore({
    resource: "https://x.example",
    total: 10,
    successes: 10,
    p95LatencyMs: 0,
    emptyOnRich: 0,
  });
  assertEquals(withNull, withZero);
});

// ── nextStatus ────────────────────────────────────────────────────────────────

Deno.test("nextStatus: blocked stays blocked regardless of reliability", () => {
  assertEquals(
    nextStatus(ServiceStatus.BLOCKED, 1.0, 100),
    ServiceStatus.BLOCKED,
  );
  assertEquals(
    nextStatus(ServiceStatus.BLOCKED, 0.0, 100),
    ServiceStatus.BLOCKED,
  );
});

Deno.test("nextStatus: no data leaves status unchanged", () => {
  assertEquals(nextStatus(ServiceStatus.ACTIVE, 1.0, 0), ServiceStatus.ACTIVE);
  assertEquals(
    nextStatus(ServiceStatus.PROBATION, 1.0, 0),
    ServiceStatus.PROBATION,
  );
});

Deno.test("nextStatus: active → probation when reliability < 0.50", () => {
  assertEquals(
    nextStatus(ServiceStatus.ACTIVE, 0.49, 100),
    ServiceStatus.PROBATION,
  );
  assertEquals(
    nextStatus(ServiceStatus.ACTIVE, 0.2, 100),
    ServiceStatus.PROBATION,
  );
});

Deno.test("nextStatus: active stays active when reliability ≥ 0.50", () => {
  assertEquals(
    nextStatus(ServiceStatus.ACTIVE, 0.5, 100),
    ServiceStatus.ACTIVE,
  );
  assertEquals(
    nextStatus(ServiceStatus.ACTIVE, 1.0, 100),
    ServiceStatus.ACTIVE,
  );
});

Deno.test("nextStatus: probation → active when reliability ≥ 0.80", () => {
  assertEquals(
    nextStatus(ServiceStatus.PROBATION, 0.8, 100),
    ServiceStatus.ACTIVE,
  );
  assertEquals(
    nextStatus(ServiceStatus.PROBATION, 1.0, 100),
    ServiceStatus.ACTIVE,
  );
});

Deno.test("nextStatus: probation stays probation in the middle band", () => {
  assertEquals(
    nextStatus(ServiceStatus.PROBATION, 0.5, 100),
    ServiceStatus.PROBATION,
  );
  assertEquals(
    nextStatus(ServiceStatus.PROBATION, 0.79, 100),
    ServiceStatus.PROBATION,
  );
});

Deno.test("nextStatus: probation → blocked when reliability < 0.20", () => {
  assertEquals(
    nextStatus(ServiceStatus.PROBATION, 0.19, 100),
    ServiceStatus.BLOCKED,
  );
  assertEquals(
    nextStatus(ServiceStatus.PROBATION, 0.0, 100),
    ServiceStatus.BLOCKED,
  );
});

// ── recomputeScores ───────────────────────────────────────────────────────────

function metrics(
  resource: string,
  total: number,
  successes: number,
  p95Ms: number | null = 500,
  emptyOnRich = 0,
): WindowMetrics {
  return { resource, total, successes, p95LatencyMs: p95Ms, emptyOnRich };
}

Deno.test(
  "recomputeScores: service with 80% failure rate is demoted from active → probation",
  async () => {
    const applied: Array<{ resource: string; score: number; status: string }> =
      [];

    const result = await recomputeScores({
      fetchMetrics: () =>
        Promise.resolve([metrics("https://flaky.example", 100, 20)]),
      fetchRegistry: () =>
        Promise.resolve([
          {
            resource: "https://flaky.example",
            status: ServiceStatus.ACTIVE,
            score: "1.0",
          },
        ]),
      applyUpdate: (resource, score, status) => {
        applied.push({ resource, score, status });
        return Promise.resolve();
      },
    });

    assertEquals(result.transitions.length, 1);
    assertEquals(result.transitions[0], {
      resource: "https://flaky.example",
      from: ServiceStatus.ACTIVE,
      to: ServiceStatus.PROBATION,
    });
    assertEquals(applied[0].status, ServiceStatus.PROBATION);
  },
);

Deno.test(
  "recomputeScores: service with 0% failure rate and low latency keeps top rank",
  async () => {
    const applied: Array<{ resource: string; score: number; status: string }> =
      [];

    const result = await recomputeScores({
      fetchMetrics: () =>
        Promise.resolve([metrics("https://perfect.example", 200, 200, 200)]),
      fetchRegistry: () =>
        Promise.resolve([
          {
            resource: "https://perfect.example",
            status: ServiceStatus.ACTIVE,
            score: "0.5",
          },
        ]),
      applyUpdate: (resource, score, status) => {
        applied.push({ resource, score, status });
        return Promise.resolve();
      },
    });

    assertEquals(applied.length, 1);
    assertEquals(applied[0].status, ServiceStatus.ACTIVE);
    // Score must be near the top (≥ 0.99)
    assertEquals(applied[0].score > 0.99, true);
    // No status transition — it was already active and stays active.
    assertEquals(result.transitions.length, 0);
  },
);

Deno.test(
  "recomputeScores: no-op when score and status are unchanged",
  async () => {
    let applyCount = 0;
    // Service already has score ~0.99 (matching what computeScore would produce)
    // and remains active → nothing to write.
    const result = await recomputeScores({
      fetchMetrics: () =>
        Promise.resolve([metrics("https://stable.example", 50, 50, 0)]),
      fetchRegistry: () =>
        Promise.resolve([
          {
            resource: "https://stable.example",
            status: ServiceStatus.ACTIVE,
            score: "1.0000",
          },
        ]),
      applyUpdate: () => {
        applyCount++;
        return Promise.resolve();
      },
    });

    assertEquals(result.updated, 0);
    assertEquals(applyCount, 0);
  },
);

Deno.test(
  "recomputeScores: blocked status never changes even with perfect reliability",
  async () => {
    const applied: Array<{ resource: string; status: string }> = [];

    await recomputeScores({
      fetchMetrics: () =>
        Promise.resolve([metrics("https://blocked.example", 100, 100)]),
      fetchRegistry: () =>
        Promise.resolve([
          {
            resource: "https://blocked.example",
            status: ServiceStatus.BLOCKED,
            score: "0.1",
          },
        ]),
      applyUpdate: (resource, _score, status) => {
        applied.push({ resource, status });
        return Promise.resolve();
      },
    });

    // Score changes (0.1 → high), so applyUpdate is called — but status must stay blocked.
    if (applied.length > 0) {
      assertEquals(applied[0].status, ServiceStatus.BLOCKED);
    }
  },
);

Deno.test(
  "recomputeScores: unknown resource in metrics is skipped gracefully",
  async () => {
    let applyCount = 0;
    const result = await recomputeScores({
      fetchMetrics: () =>
        Promise.resolve([metrics("https://unknown.example", 10, 10)]),
      fetchRegistry: () => Promise.resolve([]), // no registry row
      applyUpdate: () => {
        applyCount++;
        return Promise.resolve();
      },
    });
    assertEquals(result.updated, 0);
    assertEquals(applyCount, 0);
  },
);
