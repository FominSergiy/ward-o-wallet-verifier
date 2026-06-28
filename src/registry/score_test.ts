import { assertEquals } from "@std/assert";
import { ServiceStatus } from "../db/enums.ts";
import {
  computeScore,
  nextStatus,
  recomputeScores,
  smoothedReliability,
  type WindowMetrics,
} from "./score.ts";

// ── computeScore ──────────────────────────────────────────────────────────────

Deno.test("computeScore: zero-observation service scores low (not perfect), so it can't outrank a proven one", () => {
  const unproven = computeScore({
    resource: "https://new.example",
    total: 0,
    successes: 0,
    p95LatencyMs: null,
    emptyOnRich: 0,
  });
  // Smoothed reliability prior = 1/4 = 0.25 → 0.6*0.25 + 0.25*1 + 0.15*1 = 0.55.
  // The point: an untested service must NOT sit at 1.0 any more.
  assertEquals(unproven < 0.6, true);
  assertEquals(unproven > 0.4, true);

  // A proven, reliable service must outrank the unproven one.
  const proven = computeScore({
    resource: "https://proven.example",
    total: 100,
    successes: 95,
    p95LatencyMs: 400,
    emptyOnRich: 0,
  });
  assertEquals(proven > unproven, true);
});

Deno.test("computeScore: 0% failure + low latency yields near-maximum score", () => {
  const score = computeScore({
    resource: "https://good.example",
    total: 100,
    successes: 100,
    p95LatencyMs: 300,
    emptyOnRich: 0,
  });
  // smoothed reliability=101/104≈0.971, latency=0.99, coverage=1.0 → ≈ 0.98.
  assertEquals(score > 0.95, true);
});

Deno.test("computeScore: excluded payer-side failures don't drag reliability down", () => {
  // 8 ok, 7 errors, but all 7 errors are payment-cap excludes → effective
  // sample is 8/8, so the service should score like a reliable one, not a 53%.
  const withExcludes = computeScore({
    resource: "https://capped.example",
    total: 15,
    successes: 8,
    excluded: 7,
    p95LatencyMs: 400,
    emptyOnRich: 0,
  });
  // Without the exclusion this would be (8+1)/(15+4)=0.47 reliability → ~0.68;
  // with it, (8+1)/(8+4)=0.75 → ~0.85.
  assertEquals(withExcludes > 0.8, true);
});

Deno.test("smoothedReliability: pessimistic prior pulls low samples toward 0.25", () => {
  // 1 failure, nothing else: raw would be 0.0 (instant block); smoothed = 1/5.
  assertEquals(
    Math.abs(
      smoothedReliability({
        resource: "x",
        total: 1,
        successes: 0,
        p95LatencyMs: null,
        emptyOnRich: 0,
      }) - 0.2,
    ) < 1e-9,
    true,
  );
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
  excluded = 0,
): WindowMetrics {
  return {
    resource,
    total,
    successes,
    p95LatencyMs: p95Ms,
    emptyOnRich,
    excluded,
  };
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
    // Score must be near the top. Smoothing pulls a perfect 200/200 service to
    // ≈0.985 (201/204 reliability) — still the top tier, just no longer a
    // literal 1.0.
    assertEquals(applied[0].score > 0.95, true);
    // No status transition — it was already active and stays active.
    assertEquals(result.transitions.length, 0);
  },
);

Deno.test(
  "recomputeScores: no-op when score and status are unchanged",
  async () => {
    let applyCount = 0;
    const m = metrics("https://stable.example", 50, 50, 0);
    // Store the exact score computeScore now produces so there's nothing to
    // write (smoothing lowered the perfect-service score below 1.0).
    const stored = computeScore(m).toFixed(4);
    const result = await recomputeScores({
      fetchMetrics: () => Promise.resolve([m]),
      fetchRegistry: () =>
        Promise.resolve([
          {
            resource: "https://stable.example",
            status: ServiceStatus.ACTIVE,
            score: stored,
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
  "recomputeScores: payer-side (excluded) failures do NOT block a working service",
  async () => {
    // 8 ok + 7 payment-cap excludes over 15 calls. Raw reliability would be
    // 0.53 (and earlier runs that counted these as failures permanently blocked
    // the service). With exclusion the effective sample is 8/8 → stays active.
    const applied: Array<{ resource: string; status: string }> = [];
    await recomputeScores({
      fetchMetrics: () =>
        Promise.resolve([metrics("https://capped.example", 15, 8, 400, 0, 7)]),
      fetchRegistry: () =>
        Promise.resolve([
          {
            resource: "https://capped.example",
            status: ServiceStatus.ACTIVE,
            score: "0.5",
          },
        ]),
      applyUpdate: (resource, _score, status) => {
        applied.push({ resource, status });
        return Promise.resolve();
      },
    });
    assertEquals(applied[0].status, ServiceStatus.ACTIVE);
  },
);

Deno.test(
  "recomputeScores: a tiny all-failure sample does NOT hard-block (min-sample guard)",
  async () => {
    // 0/2 failures is below MIN_BLOCK_OBSERVATIONS — stay in probation, don't
    // permanently block on noise. (Structural deadness is blocked elsewhere.)
    const applied: Array<{ resource: string; status: string }> = [];
    await recomputeScores({
      fetchMetrics: () =>
        Promise.resolve([metrics("https://tiny.example", 2, 0)]),
      fetchRegistry: () =>
        Promise.resolve([
          {
            resource: "https://tiny.example",
            status: ServiceStatus.PROBATION,
            score: "0.5",
          },
        ]),
      applyUpdate: (resource, _score, status) => {
        applied.push({ resource, status });
        return Promise.resolve();
      },
    });
    // It may rescore, but must NOT become blocked.
    if (applied.length > 0) {
      assertEquals(applied[0].status, ServiceStatus.PROBATION);
    }
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
