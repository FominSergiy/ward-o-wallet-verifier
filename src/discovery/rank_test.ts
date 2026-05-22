import { assertEquals } from "@std/assert";
import { z } from "zod";
import { rankServices } from "./rank.ts";
import { mockLlm, type LlmClient } from "../agent/llm.ts";
import {
  _resetHealthStoreForTests,
  recordError,
  recordOk,
} from "./health_store.ts";
import type { DiscoveryCandidatesByCategory, DiscoveryEntry } from "./types.ts";

// Each test that exercises rank's prompt gets a fresh health store.
function withTempHealthStore(fn: () => Promise<void>): Promise<void> {
  const tmp = Deno.makeTempFileSync({ suffix: ".json" });
  Deno.env.set("HEALTH_STORE_PATH", tmp);
  _resetHealthStoreForTests();
  return fn().finally(() => {
    Deno.env.delete("HEALTH_STORE_PATH");
    try {
      Deno.removeSync(tmp);
    } catch {
      // ignore
    }
  });
}

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

Deno.test("rankServices includes recentFailureRate in the prompt", async () => {
  await withTempHealthStore(async () => {
    // Seed the store with a known-bad and a known-good service.
    recordError("https://bad.example", "Bad Request");
    recordError("https://bad.example", "Bad Request");
    recordOk("https://good.example");
    const candidates: DiscoveryCandidatesByCategory = {
      walletNetwork: "base",
      candidates: {
        sanctions: [
          entry({ resource: "https://bad.example", amount: "1000" }),
          entry({ resource: "https://good.example", amount: "1000" }),
          entry({ resource: "https://unknown.example", amount: "1000" }),
        ],
      },
      errors: {},
    };
    let captured = "";
    const llm: LlmClient = {
      generateStructured<T>(
        schema: z.ZodType<T>,
        prompt: string,
      ): Promise<T> {
        captured = prompt;
        return Promise.resolve(
          schema.parse({
            selections: [{ category: "sanctions", resourceIndex: 1, rationale: "r" }],
          }),
        );
      },
    };
    await rankServices(candidates, llm);
    // The bad service should show 100% failure rate.
    assertEquals(captured.includes("https://bad.example"), true);
    assertEquals(captured.includes("recentFailureRate: 100%"), true);
    // The good service should show 0%.
    assertEquals(captured.includes("recentFailureRate: 0%"), true);
    // The unknown service shows "unknown (untested)".
    assertEquals(captured.includes("unknown (untested)"), true);
  });
});

Deno.test("rankServices includes inputInfoCompleteness score for each candidate", async () => {
  await withTempHealthStore(async () => {
    const skeletal: DiscoveryEntry = {
      resource: "https://skel.example",
      description: "x",
      accepts: [{
        amount: "1000",
        asset: "0xUSDC",
        network: "eip155:8453",
        payTo: "0xpay",
        scheme: "exact",
        maxTimeoutSeconds: 60,
      }],
      // No extensions.bazaar.info — completeness = 0
    };
    const full: DiscoveryEntry = {
      resource: "https://full.example",
      description: "x",
      accepts: skeletal.accepts,
      extensions: {
        bazaar: {
          info: {
            input: {
              method: "GET",
              queryParams: { wallet: "0xexample" },
              body: { foo: "bar" },
            },
          },
        },
      },
    };
    const candidates: DiscoveryCandidatesByCategory = {
      walletNetwork: "base",
      candidates: { sanctions: [skeletal, full] },
      errors: {},
    };
    let captured = "";
    const llm: LlmClient = {
      generateStructured<T>(
        schema: z.ZodType<T>,
        prompt: string,
      ): Promise<T> {
        captured = prompt;
        return Promise.resolve(
          schema.parse({
            selections: [{ category: "sanctions", resourceIndex: 1, rationale: "r" }],
          }),
        );
      },
    };
    await rankServices(candidates, llm);
    assertEquals(captured.includes("inputInfoCompleteness: 0/3"), true);
    assertEquals(captured.includes("inputInfoCompleteness: 3/3"), true);
  });
});

Deno.test("rankServices preserves inputInfo from DiscoveryEntry", async () => {
  const inputInfo = {
    method: "GET",
    queryParams: { wallet: "0xexample" },
    type: "http",
  };
  const entryWithInfo: DiscoveryEntry = {
    resource: "https://svc",
    description: "x",
    accepts: [{
      amount: "1000",
      asset: "0xUSDC",
      network: "eip155:8453",
      payTo: "0xpay",
      scheme: "exact",
      maxTimeoutSeconds: 60,
    }],
    extensions: { bazaar: { info: { input: inputInfo } } },
  };
  const candidates: DiscoveryCandidatesByCategory = {
    walletNetwork: "base",
    candidates: { sanctions: [entryWithInfo] },
    errors: {},
  };
  const llm = mockLlm({
    RankedSelection: {
      selections: [{ category: "sanctions", resourceIndex: 0, rationale: "r" }],
    },
  });
  const out = await rankServices(candidates, llm);
  assertEquals(out[0].inputInfo, inputInfo);
});

Deno.test("rankServices leaves inputInfo undefined when absent", async () => {
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
  assertEquals(out[0].inputInfo, undefined);
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
