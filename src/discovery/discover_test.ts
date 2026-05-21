import { assertEquals, assertRejects } from "@std/assert";
import { discover } from "./discover.ts";
import { mockLlm } from "../agent/llm.ts";
import {
  WalletUnfundedError,
  type DiscoveryCandidatesByCategory,
  type RankedService,
} from "./types.ts";

function ranked(args: Partial<RankedService> & { category: RankedService["category"] }): RankedService {
  return {
    category: args.category,
    resource: args.resource ?? "https://x",
    description: args.description ?? "x",
    priceUsdc: args.priceUsdc ?? 0.001,
    network: args.network ?? "eip155:8453",
    payTo: args.payTo ?? "0xpay",
    scheme: args.scheme ?? "exact",
    qualityScore: args.qualityScore ?? null,
    rationale: args.rationale ?? "r",
  };
}

Deno.test("discover composes detect→fetch→rank→format", async () => {
  const candidates: DiscoveryCandidatesByCategory = {
    walletNetwork: "base",
    candidates: {},
    errors: {},
  };
  const plan = await discover("0xABC", ["sanctions"], {
    detectNetwork: () => Promise.resolve("base"),
    fetcher: () => Promise.resolve(candidates),
    ranker: () => Promise.resolve([ranked({ category: "sanctions", resource: "https://s" })]),
    llm: mockLlm({}),
  });
  assertEquals(plan.address, "0xABC");
  assertEquals(plan.walletNetwork, "base");
  assertEquals(plan.services.length, 1);
  assertEquals(plan.services[0].resource, "https://s");
  assertEquals(typeof plan.generatedAt, "string");
});

Deno.test("discover sums totalEstimatedCostUsdc", async () => {
  const plan = await discover("0xABC", ["sanctions", "labels", "onchain_history"], {
    detectNetwork: () => Promise.resolve("base"),
    fetcher: () =>
      Promise.resolve({
        walletNetwork: "base",
        candidates: {},
        errors: {},
      }),
    ranker: () =>
      Promise.resolve([
        ranked({ category: "sanctions", priceUsdc: 0.001 }),
        ranked({ category: "labels", priceUsdc: 0.002 }),
        ranked({ category: "onchain_history", priceUsdc: 0.0007 }),
      ]),
    llm: mockLlm({}),
  });
  // floating point — check within tolerance
  assertEquals(Math.abs(plan.totalEstimatedCostUsdc - 0.0037) < 1e-9, true);
});

Deno.test("discover surfaces WalletUnfundedError", async () => {
  await assertRejects(
    () =>
      discover("0xABC", ["sanctions"], {
        detectNetwork: () => Promise.reject(new WalletUnfundedError("0xA", "0xB")),
        fetcher: () => Promise.reject(new Error("should not be called")),
        ranker: () => Promise.reject(new Error("should not be called")),
        llm: mockLlm({}),
      }),
    WalletUnfundedError,
  );
});

Deno.test("discover lists unresolvedCategories", async () => {
  const plan = await discover(
    "0xABC",
    ["sanctions", "labels", "onchain_history", "web_sentiment", "contract_analysis"],
    {
      detectNetwork: () => Promise.resolve("base"),
      fetcher: () =>
        Promise.resolve({
          walletNetwork: "base",
          candidates: {},
          errors: {},
        }),
      ranker: () =>
        Promise.resolve([
          ranked({ category: "sanctions" }),
          ranked({ category: "labels" }),
          ranked({ category: "onchain_history" }),
        ]),
      llm: mockLlm({}),
    },
  );
  assertEquals(plan.unresolvedCategories.sort(), ["contract_analysis", "web_sentiment"]);
});

Deno.test("discover excludes ens from unresolvedCategories", async () => {
  const plan = await discover("0xABC", ["sanctions", "ens"], {
    detectNetwork: () => Promise.resolve("base"),
    fetcher: () =>
      Promise.resolve({
        walletNetwork: "base",
        candidates: {},
        errors: {},
      }),
    ranker: () => Promise.resolve([ranked({ category: "sanctions" })]),
    llm: mockLlm({}),
  });
  assertEquals(plan.unresolvedCategories.includes("ens"), false);
  assertEquals(plan.unresolvedCategories.length, 0);
});
