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
    // Both label queries (attribution + phishing) fail with the same error.
    if (params.query.includes("attribution") || params.query.includes("phishing")) {
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
  assertEquals(out.errors.labels?.includes("upstream 500"), true);
  assertEquals(out.errors.onchain_history, "no results");
  assertEquals("sanctions" in out.errors, false);
});

Deno.test("fetchCandidates unions and de-dupes multi-query labels", async () => {
  const callsByQuery: Record<string, number> = {};
  const client = (params: SearchParams) => {
    callsByQuery[params.query] = (callsByQuery[params.query] ?? 0) + 1;
    if (params.query.includes("attribution")) {
      // First query returns two distinct services.
      return Promise.resolve([
        makeEntry("eip155:8453", "https://attribute.example/a"),
        makeEntry("eip155:8453", "https://shared.example/b"),
      ]);
    }
    if (params.query.includes("phishing")) {
      // Second query returns one new + one overlap (b) — overlap must dedupe.
      return Promise.resolve([
        makeEntry("eip155:8453", "https://shared.example/b"),
        makeEntry("eip155:8453", "https://phish.example/c"),
      ]);
    }
    return Promise.resolve([]);
  };
  const out = await fetchCandidates(["labels"], "base", { client });
  // 2 distinct queries fired.
  assertEquals(Object.keys(callsByQuery).length, 2);
  // Union has 3 unique resources (a, b, c) — b deduped.
  const urls = out.candidates.labels?.map((e) => e.resource).sort() ?? [];
  assertEquals(urls, [
    "https://attribute.example/a",
    "https://phish.example/c",
    "https://shared.example/b",
  ]);
  assertEquals("labels" in out.errors, false);
});

Deno.test("fetchCandidates surfaces partial success when one labels query empty", async () => {
  const client = (params: SearchParams) => {
    if (params.query.includes("attribution")) {
      return Promise.resolve([makeEntry("eip155:8453", "https://attribute.example/a")]);
    }
    // Phishing query returns empty.
    return Promise.resolve([]);
  };
  const out = await fetchCandidates(["labels"], "base", { client });
  assertEquals(out.candidates.labels?.length, 1);
  // Some results found → no error reported, even though one sub-query was empty.
  assertEquals("labels" in out.errors, false);
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
