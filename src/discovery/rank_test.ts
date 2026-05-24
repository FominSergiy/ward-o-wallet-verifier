import { assertEquals } from "@std/assert";
import { z } from "zod";
import { rankServices } from "./rank.ts";
import { mockLlm, type LlmClient } from "../agent/llm.ts";
import {
  _resetHealthStoreForTests,
  recordEmptyOnRich,
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

Deno.test("rankServices filters durably-blocked candidates from the rerank prompt", async () => {
  await withTempHealthStore(async () => {
    // Seed: one service durably blocked, one healthy.
    recordError(
      "https://blocked.example",
      "Payment Required",
      "payment_exceeds_max",
    );
    const candidates: DiscoveryCandidatesByCategory = {
      walletNetwork: "base",
      candidates: {
        sanctions: [
          entry({ resource: "https://blocked.example", amount: "1000" }),
          entry({ resource: "https://healthy.example", amount: "1000" }),
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
            // Healthy is now at index 0 after filtering.
            selections: [{ category: "sanctions", resourceIndex: 0, rationale: "r" }],
          }),
        );
      },
    };
    const out = await rankServices(candidates, llm);
    assertEquals(captured.includes("https://blocked.example"), false);
    assertEquals(captured.includes("https://healthy.example"), true);
    assertEquals(out.length, 1);
    assertEquals(out[0].resource, "https://healthy.example");
  });
});

Deno.test("rankServices re-includes durably-blocked candidates if filtering empties a category", async () => {
  await withTempHealthStore(async () => {
    recordError(
      "https://only-option.example",
      "Payment Required",
      "payment_exceeds_max",
    );
    const candidates: DiscoveryCandidatesByCategory = {
      walletNetwork: "base",
      candidates: {
        sanctions: [
          entry({ resource: "https://only-option.example", amount: "1000" }),
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
            selections: [{ category: "sanctions", resourceIndex: 0, rationale: "r" }],
          }),
        );
      },
    };
    const out = await rankServices(candidates, llm);
    assertEquals(captured.includes("https://only-option.example"), true);
    assertEquals(out.length, 1);
    assertEquals(out[0].resource, "https://only-option.example");
  });
});

Deno.test("rankServices fallback prefers entity-attribution descriptions for labels (tie-break)", async () => {
  await withTempHealthStore(async () => {
    const plain = entry({
      resource: "https://lbl.plain",
      amount: "1000",
      quality: 5,
      desc: "Generic labeler that returns wallet tags.",
    });
    const entityy = entry({
      resource: "https://lbl.entity",
      amount: "1000",
      quality: 5,
      desc: "Provides entity attribution, name tag and known address database for CEX hot wallet identification.",
    });
    const candidates: DiscoveryCandidatesByCategory = {
      walletNetwork: "base",
      candidates: { labels: [plain, entityy] },
      errors: {},
    };
    // Force the fallback path by failing the LLM.
    const failingLlm: LlmClient = {
      generateStructured<T>(_s: z.ZodType<T>, _p: string): Promise<T> {
        return Promise.reject(new Error("rerank down"));
      },
    };
    const out = await rankServices(candidates, failingLlm);
    assertEquals(out.length, 1);
    assertEquals(out[0].resource, "https://lbl.entity");
  });
});

Deno.test("rankServices fallback does NOT apply entity tie-break to non-labels categories", async () => {
  await withTempHealthStore(async () => {
    const plain = entry({
      resource: "https://sanc.plain",
      amount: "1000",
      quality: 5,
      desc: "Sanctions screening.",
    });
    const entityy = entry({
      resource: "https://sanc.entity",
      amount: "1000",
      quality: 5,
      desc: "Sanctions screening with entity attribution and name tag.",
    });
    const candidates: DiscoveryCandidatesByCategory = {
      walletNetwork: "base",
      candidates: { sanctions: [plain, entityy] },
      errors: {},
    };
    const failingLlm: LlmClient = {
      generateStructured<T>(_s: z.ZodType<T>, _p: string): Promise<T> {
        return Promise.reject(new Error("rerank down"));
      },
    };
    const out = await rankServices(candidates, failingLlm);
    // First entry wins on the bare quality+price comparison (no entity bump).
    assertEquals(out.length, 1);
    assertEquals(out[0].resource, "https://sanc.plain");
  });
});

Deno.test("rankServices surfaces an entity-attribution hint in the prompt for labels candidates", async () => {
  await withTempHealthStore(async () => {
    const plain = entry({
      resource: "https://lbl.plain",
      amount: "1000",
      desc: "Generic labeler returning wallet tags.",
    });
    const entityy = entry({
      resource: "https://lbl.entity",
      amount: "1000",
      desc: "Entity attribution with name tag for hot wallet identification.",
    });
    const candidates: DiscoveryCandidatesByCategory = {
      walletNetwork: "base",
      candidates: { labels: [plain, entityy] },
      errors: {},
    };
    let captured = "";
    const llm: LlmClient = {
      generateStructured<T>(s: z.ZodType<T>, prompt: string): Promise<T> {
        captured = prompt;
        return Promise.resolve(
          s.parse({
            selections: [{ category: "labels", resourceIndex: 1, rationale: "r" }],
          }),
        );
      },
    };
    await rankServices(candidates, llm);
    // The entity-attribution candidate gets the hint annotation.
    assertEquals(captured.includes("https://lbl.entity"), true);
    assertEquals(
      captured.includes("[hint: description mentions entity-attribution keywords]"),
      true,
    );
  });
});

Deno.test("rankServices pushes quality-demoted candidates to the bottom of their category", async () => {
  await withTempHealthStore(async () => {
    // Demote one service via 3 empty-on-rich-history records.
    const demoted = "https://lbl.demoted";
    recordEmptyOnRich(demoted);
    recordEmptyOnRich(demoted);
    recordEmptyOnRich(demoted);

    const candidates: DiscoveryCandidatesByCategory = {
      walletNetwork: "base",
      candidates: {
        labels: [
          entry({ resource: demoted, amount: "1000" }),
          entry({ resource: "https://lbl.fresh", amount: "1000" }),
        ],
      },
      errors: {},
    };
    let captured = "";
    const llm: LlmClient = {
      generateStructured<T>(s: z.ZodType<T>, prompt: string): Promise<T> {
        captured = prompt;
        return Promise.resolve(
          s.parse({
            selections: [{ category: "labels", resourceIndex: 0, rationale: "r" }],
          }),
        );
      },
    };
    await rankServices(candidates, llm);
    // Demoted resource appears AFTER the fresh one in the prompt.
    const idxDemoted = captured.indexOf(demoted);
    const idxFresh = captured.indexOf("https://lbl.fresh");
    assertEquals(idxDemoted > idxFresh, true);
  });
});

Deno.test("rankServices surfaces a host-diversity hint when the same host appears across categories", async () => {
  await withTempHealthStore(async () => {
    // Same host (orbisapi.com) in two categories — should be tagged.
    const candidates: DiscoveryCandidatesByCategory = {
      walletNetwork: "base",
      candidates: {
        labels: [
          entry({
            resource: "https://orbisapi.com/proxy/labeler",
            amount: "1000",
          }),
        ],
        web_sentiment: [
          entry({
            resource: "https://orbisapi.com/proxy/sentiment",
            amount: "1000",
          }),
          // A non-colliding alternative.
          entry({
            resource: "https://other-host.example/sentiment",
            amount: "1000",
          }),
        ],
      },
      errors: {},
    };
    let captured = "";
    const llm: LlmClient = {
      generateStructured<T>(s: z.ZodType<T>, prompt: string): Promise<T> {
        captured = prompt;
        return Promise.resolve(
          s.parse({
            selections: [
              { category: "labels", resourceIndex: 0, rationale: "r" },
              { category: "web_sentiment", resourceIndex: 1, rationale: "r" },
            ],
          }),
        );
      },
    };
    await rankServices(candidates, llm);
    // The Orbis entry in web_sentiment should carry the cross-category hint.
    assertEquals(
      captured.includes(
        "[hint: host orbisapi.com also appears in candidates for: labels]",
      ),
      true,
    );
    // The non-colliding host should NOT carry the hint.
    assertEquals(
      captured.includes(
        "[hint: host other-host.example also appears in candidates for",
      ),
      false,
    );
    // Rule 7 must appear in the prompt so the LLM knows what to do.
    assertEquals(captured.includes("Host diversity"), true);
  });
});

Deno.test("rankServices omits host-diversity hint when a host only appears once", async () => {
  await withTempHealthStore(async () => {
    const candidates: DiscoveryCandidatesByCategory = {
      walletNetwork: "base",
      candidates: {
        sanctions: [
          entry({ resource: "https://only-here.example/api", amount: "1000" }),
        ],
        labels: [
          entry({ resource: "https://different.example/lbl", amount: "1000" }),
        ],
      },
      errors: {},
    };
    let captured = "";
    const llm: LlmClient = {
      generateStructured<T>(s: z.ZodType<T>, prompt: string): Promise<T> {
        captured = prompt;
        return Promise.resolve(
          s.parse({
            selections: [
              { category: "sanctions", resourceIndex: 0, rationale: "r" },
              { category: "labels", resourceIndex: 0, rationale: "r" },
            ],
          }),
        );
      },
    };
    await rankServices(candidates, llm);
    // No host-collision hints attached to any candidate. Rule 7's *description*
    // mentions "also appears in candidates for" so we look specifically for
    // the hint-attached form (`[hint: host ...`) which only fires on
    // cross-category hosts.
    assertEquals(captured.includes("[hint: host only-here.example"), false);
    assertEquals(captured.includes("[hint: host different.example"), false);
  });
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
