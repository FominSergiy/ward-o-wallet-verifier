import { assertEquals, assertRejects } from "@std/assert";
import { searchDiscovery } from "./client.ts";
import { DiscoveryFetchError, type DiscoveryEntry } from "./types.ts";

function makeEntry(network: string, resource = "https://svc.example/v1"): DiscoveryEntry {
  return {
    resource,
    description: "test service",
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

function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (_url, _init) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

Deno.test("searchDiscovery builds correct URL with all params", async () => {
  let captured = "";
  const fetchFn: typeof globalThis.fetch = (url, _init) => {
    captured = url.toString();
    return Promise.resolve(
      new Response(JSON.stringify({ resources: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  await searchDiscovery(
    { query: "sanctions screening", network: "eip155:8453", maxUsdPrice: 0.01, limit: 5 },
    fetchFn,
  );
  // URLSearchParams encodes space as +
  assertEquals(captured.includes("query=sanctions+screening"), true);
  assertEquals(captured.includes("network=eip155%3A8453"), true);
  assertEquals(captured.includes("maxUsdPrice=0.01"), true);
  assertEquals(captured.includes("limit=5"), true);
});

Deno.test("searchDiscovery filters out off-network entries", async () => {
  const fetchFn = mockFetch(200, {
    resources: [
      makeEntry("eip155:8453", "https://a.example"),
      makeEntry("solana:5eykt4UsFv8P8NJ", "https://b.example"),
      makeEntry("eip155:8453", "https://c.example"),
    ],
  });
  const out = await searchDiscovery({ query: "x", network: "eip155:8453" }, fetchFn);
  assertEquals(out.length, 2);
  assertEquals(out[0].resource, "https://a.example");
  assertEquals(out[1].resource, "https://c.example");
});

Deno.test("searchDiscovery returns empty array on no results", async () => {
  const fetchFn = mockFetch(200, { resources: [] });
  const out = await searchDiscovery({ query: "x", network: "eip155:8453" }, fetchFn);
  assertEquals(out, []);
});

Deno.test("searchDiscovery throws DiscoveryFetchError on 500", async () => {
  const fetchFn = mockFetch(500, { error: "server" });
  await assertRejects(
    () => searchDiscovery({ query: "x", network: "eip155:8453" }, fetchFn),
    DiscoveryFetchError,
    "HTTP 500",
  );
});

Deno.test("searchDiscovery throws on malformed JSON", async () => {
  const fetchFn: typeof globalThis.fetch = (_url, _init) =>
    Promise.resolve(
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  await assertRejects(
    () => searchDiscovery({ query: "x", network: "eip155:8453" }, fetchFn),
    DiscoveryFetchError,
    "malformed JSON",
  );
});
