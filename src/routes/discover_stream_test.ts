import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { createDiscoverStreamRouter } from "./discover_stream.ts";
import type { Category } from "../agent/types.ts";
import type { DiscoveryPlan } from "../discovery/types.ts";
import type { EventEmitter } from "../agent/events.ts";

interface ParsedFrame {
  event: string;
  data: string;
}

async function readSSEFrames(res: Response): Promise<ParsedFrame[]> {
  const text = await res.text();
  const frames: ParsedFrame[] = [];
  for (const block of text.split(/\n\n+/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    frames.push({ event, data: dataLines.join("\n") });
  }
  return frames;
}

function fakePlan(): DiscoveryPlan {
  return {
    address: "0xABC0000000000000000000000000000000000123",
    walletNetwork: "base",
    services: [
      {
        category: "sanctions" as Category,
        resource: "https://sanc.example",
        description: "x",
        priceUsdc: 0.001,
        network: "eip155:8453",
        payTo: "0xp",
        scheme: "exact",
        qualityScore: null,
        rationale: "r",
      },
    ],
    alternates: {},
    totalEstimatedCostUsdc: 0.001,
    unresolvedCategories: ["web_sentiment" as Category],
    generatedAt: new Date().toISOString(),
  };
}

function buildApp(
  discoverFn: (
    address: string,
    categories: Category[],
    opts: { onEvent?: EventEmitter },
  ) => Promise<DiscoveryPlan>,
): Hono {
  const app = new Hono();
  const router = createDiscoverStreamRouter({
    discoverFn: discoverFn as unknown as
      typeof import("../discovery/discover.ts").discover,
  });
  app.route("/discover-stream", router);
  return app;
}

Deno.test("POST /discover-stream streams phase, log, plan events in order", async () => {
  const app = buildApp((_addr, _cats, opts) => {
    const emit = opts.onEvent!;
    // Mirror the real discover() emission shape.
    emit({
      type: "log",
      level: "info",
      message: "wallet network detected: base",
      at: "t",
    });
    emit({
      type: "log",
      level: "info",
      message: "fetched 10 candidates for sanctions",
      at: "t",
    });
    return Promise.resolve(fakePlan());
  });

  const res = await app.request("/discover-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: "0xABC0000000000000000000000000000000000123",
    }),
  });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/event-stream");

  const frames = await readSSEFrames(res);
  const eventNames = frames.map((f) => f.event);
  // Logs precede the final plan frame.
  assertEquals(eventNames[0], "log");
  assertEquals(eventNames[1], "log");
  assertEquals(eventNames[eventNames.length - 1], "plan");
  // No error frames in the happy path.
  assertEquals(eventNames.includes("error"), false);

  const planFrame = frames[frames.length - 1];
  const planBody = JSON.parse(planFrame.data) as {
    type: string;
    services: Array<{ category: string; priceUsdc: number }>;
    totalEstimatedCostUsdc: number;
    walletNetwork: string;
    unresolvedCategories: string[];
  };
  assertEquals(planBody.type, "plan");
  assertEquals(planBody.walletNetwork, "base");
  assertEquals(planBody.totalEstimatedCostUsdc, 0.001);
  assertEquals(planBody.services.length, 1);
  assertEquals(planBody.services[0].category, "sanctions");
  assertEquals(planBody.unresolvedCategories, ["web_sentiment"]);
});

Deno.test("POST /discover-stream WalletUnfundedError emits error event with code wallet_unfunded", async () => {
  const { WalletUnfundedError } = await import("../discovery/types.ts");
  const app = buildApp(() =>
    Promise.reject(new WalletUnfundedError("0xA", "0xB"))
  );
  const res = await app.request("/discover-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: "0xABC0000000000000000000000000000000000123",
    }),
  });
  assertEquals(res.status, 200);
  const frames = await readSSEFrames(res);
  const errFrame = frames.find((f) => f.event === "error");
  assertEquals(errFrame !== undefined, true);
  const body = JSON.parse(errFrame!.data) as { code: string; status: number };
  assertEquals(body.code, "wallet_unfunded");
  assertEquals(body.status, 402);
});

Deno.test("POST /discover-stream rejects malformed body with 400 before stream opens", async () => {
  const app = buildApp(() => Promise.resolve(fakePlan()));
  const res = await app.request("/discover-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: "not-an-address" }),
  });
  assertEquals(res.status, 400);
});
