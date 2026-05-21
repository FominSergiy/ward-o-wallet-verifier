import { assertEquals } from "@std/assert";
import { z } from "zod";
import { rankServices } from "./rank.ts";
import { mockLlm, type LlmClient } from "../agent/llm.ts";
import type { DiscoveryCandidatesByCategory, DiscoveryEntry } from "./types.ts";

function entry(args: {
  resource: string;
  amount: string;
  quality?: number;
  desc?: string;
}): DiscoveryEntry {
  return {
    resource: args.resource,
    description: args.desc ?? "test service",
    accepts: [{
      amount: args.amount,
      asset: "0xUSDC",
      network: "eip155:8453",
      payTo: "0xpay",
      scheme: "exact",
      maxTimeoutSeconds: 60,
    }],
    extensions: args.quality !== undefined
      ? { bazaar: { quality: { l30DaysUniquePayers: args.quality } } }
      : undefined,
  };
}

Deno.test("rankServices returns one per category", async () => {
  const candidates: DiscoveryCandidatesByCategory = {
    walletNetwork: "base",
    candidates: {
      sanctions: [
        entry({ resource: "https://s0", amount: "1000" }),
        entry({ resource: "https://s1", amount: "2000" }),
      ],
      labels: [entry({ resource: "https://l0", amount: "500" })],
    },
    errors: {},
  };
  const llm = mockLlm({
    RankedSelection: {
      selections: [
        { category: "sanctions", resourceIndex: 0, rationale: "best" },
        { category: "labels", resourceIndex: 0, rationale: "only choice" },
      ],
    },
  });
  const out = await rankServices(candidates, llm);
  assertEquals(out.length, 2);
  assertEquals(out[0].category, "sanctions");
  assertEquals(out[0].resource, "https://s0");
});

Deno.test("rankServices parses price correctly", async () => {
  const candidates: DiscoveryCandidatesByCategory = {
    walletNetwork: "base",
    candidates: {
      sanctions: [entry({ resource: "https://s", amount: "1000" })],
    },
    errors: {},
  };
  const llm = mockLlm({
    RankedSelection: {
      selections: [{ category: "sanctions", resourceIndex: 0, rationale: "r" }],
    },
  });
  const out = await rankServices(candidates, llm);
  assertEquals(out[0].priceUsdc, 0.001);
});

Deno.test("rankServices bounds-checks LLM index", async () => {
  const candidates: DiscoveryCandidatesByCategory = {
    walletNetwork: "base",
    candidates: {
      sanctions: [entry({ resource: "https://s0", amount: "1000" })],
    },
    errors: {},
  };
  const llm = mockLlm({
    RankedSelection: {
      selections: [{ category: "sanctions", resourceIndex: 99, rationale: "bad" }],
    },
  });
  const out = await rankServices(candidates, llm);
  assertEquals(out.length, 0);
});

Deno.test("rankServices falls back to quality-sort on LLM failure", async () => {
  const candidates: DiscoveryCandidatesByCategory = {
    walletNetwork: "base",
    candidates: {
      sanctions: [
        entry({ resource: "https://low", amount: "1000", quality: 1 }),
        entry({ resource: "https://high", amount: "5000", quality: 100 }),
      ],
    },
    errors: {},
  };
  const failingLlm: LlmClient = {
    generateStructured<T>(_schema: z.ZodType<T>, _prompt: string): Promise<T> {
      return Promise.reject(new Error("LLM down"));
    },
  };
  const out = await rankServices(candidates, failingLlm);
  assertEquals(out.length, 1);
  assertEquals(out[0].resource, "https://high");
  assertEquals(out[0].qualityScore, 100);
});

Deno.test("rankServices returns empty on empty candidates", async () => {
  const candidates: DiscoveryCandidatesByCategory = {
    walletNetwork: "base",
    candidates: {},
    errors: {},
  };
  const llm = mockLlm({ RankedSelection: { selections: [] } });
  const out = await rankServices(candidates, llm);
  assertEquals(out, []);
});

Deno.test("rankServices skips categories missing from LLM output", async () => {
  const candidates: DiscoveryCandidatesByCategory = {
    walletNetwork: "base",
    candidates: {
      sanctions: [entry({ resource: "https://s", amount: "1000" })],
      labels: [entry({ resource: "https://l", amount: "1000" })],
    },
    errors: {},
  };
  const llm = mockLlm({
    RankedSelection: {
      selections: [{ category: "sanctions", resourceIndex: 0, rationale: "ok" }],
    },
  });
  const out = await rankServices(candidates, llm);
  assertEquals(out.length, 1);
  assertEquals(out[0].category, "sanctions");
});
