import { assertEquals } from "@std/assert";
import { fetchCandidates } from "./orchestrator.ts";
import type { DiscoveryEntry, SearchParams } from "./types.ts";

function makeEntry(network: string, resource: string): DiscoveryEntry {
  return {
    resource,
    description: "x",
    accepts: [{
      amount: "1000",
      asset: "0xUSDC",
      network,
      payTo: "0xpay",
      scheme: "exact",
      maxTimeoutSeconds: 60,
    }],
  };
}

Deno.test("fetchCandidates fans out concurrently", async () => {
  const sleepClient = (_p: SearchParams) =>
    new Promise<DiscoveryEntry[]>((resolve) =>
      setTimeout(() => resolve([makeEntry("eip155:8453", "https://x")]), 100)
    );
  const start = performance.now();
  await fetchCandidates(
    ["sanctions", "labels", "onchain_history", "web_sentiment", "contract_analysis"],
    "base",
    { client: sleepClient },
  );
  const elapsed = performance.now() - start;
  // 5 categories × 100ms = 500ms if sequential, ~100ms if parallel.
  assertEquals(elapsed < 300, true, `expected parallel (~100ms), got ${elapsed}ms`);
});

Deno.test("fetchCandidates collects partial results", async () => {
  const client = (params: SearchParams) => {
    if (params.query.includes("OFAC")) {
      return Promise.resolve([makeEntry("eip155:8453", "https://sanc")]);
    }
    if (params.query.includes("attribution")) {
      return Promise.reject(new Error("upstream 500"));
    }
    // onchain → empty
    return Promise.resolve([]);
  };
  const out = await fetchCandidates(
    ["sanctions", "labels", "onchain_history"],
    "base",
    { client },
  );
  assertEquals(out.candidates.sanctions?.length, 1);
  assertEquals(out.errors.labels, "upstream 500");
  assertEquals(out.errors.onchain_history, "no results");
  assertEquals("sanctions" in out.errors, false);
});

Deno.test("fetchCandidates drops ens from input", async () => {
  const calledQueries: string[] = [];
  const client = (params: SearchParams) => {
    calledQueries.push(params.query);
    return Promise.resolve([makeEntry("eip155:8453", "https://x")]);
  };
  await fetchCandidates(["ens", "sanctions"], "base", { client });
  assertEquals(calledQueries.length, 1);
  assertEquals(calledQueries[0].includes("sanctions"), true);
});

Deno.test("fetchCandidates passes walletNetwork as CAIP-2 to client", async () => {
  let capturedNetwork = "";
  const client = (params: SearchParams) => {
    capturedNetwork = params.network;
    return Promise.resolve([makeEntry(params.network, "https://x")]);
  };
  await fetchCandidates(["sanctions"], "base", { client });
  assertEquals(capturedNetwork, "eip155:8453");

  await fetchCandidates(["sanctions"], "base-sepolia", { client });
  assertEquals(capturedNetwork, "eip155:84532");
});

Deno.test("fetchCandidates echoes walletNetwork in return", async () => {
  const client = () => Promise.resolve([]);
  const out = await fetchCandidates(["sanctions"], "base-sepolia", { client });
  assertEquals(out.walletNetwork, "base-sepolia");
});
