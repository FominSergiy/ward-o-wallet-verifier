import { assertEquals, assertRejects } from "@std/assert";
import {
  ETH_LABELS_BASE_URL,
  fetchLabelsRegistry,
  LabelsRegistryError,
} from "./labels_registry.ts";
import { newMemoryKv } from "../cache/kv.ts";

function jsonFetcher(body: unknown, status = 200): typeof fetch {
  // deno-lint-ignore require-await
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function textFetcher(body: string, status = 200): typeof fetch {
  // deno-lint-ignore require-await
  return (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
}

Deno.test("happy_path_known_cex_returns_labels", async () => {
  const fixture = [
    {
      address: "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
      chainId: 1,
      label: "coinbase",
      nameTag: "Coinbase 1",
    },
    {
      address: "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
      chainId: 1,
      label: "fiat-gateway",
      nameTag: "Coinbase 1",
    },
  ];
  const result = await fetchLabelsRegistry(
    "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3",
    "eth",
    { fetcher: jsonFetcher(fixture), cache: newMemoryKv() },
  );
  assertEquals(result.source, "eth_labels_registry");
  assertEquals(result.endpoint.startsWith(ETH_LABELS_BASE_URL), true);
  assertEquals(result.labels.length, 2);
  assertEquals(result.labels[0].label, "coinbase");
  assertEquals(result.labels[0].nameTag, "Coinbase 1");
  assertEquals(result.labels[0].chainId, 1);
});

Deno.test("empty_array_returns_empty_labels", async () => {
  const result = await fetchLabelsRegistry(
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "eth",
    { fetcher: jsonFetcher([]), cache: newMemoryKv() },
  );
  assertEquals(result.labels, []);
  assertEquals(result.source, "eth_labels_registry");
});

Deno.test("invalid_address_endpoint_error_throws", async () => {
  await assertRejects(
    () =>
      fetchLabelsRegistry(
        "0xAaBbCcDdEeFf00112233445566778899AaBbCcDd",
        "eth",
        {
          fetcher: jsonFetcher({ error: "Invalid address format" }),
          cache: newMemoryKv(),
        },
      ),
    LabelsRegistryError,
    "Invalid address format",
  );
});

Deno.test("non_200_throws", async () => {
  await assertRejects(
    () =>
      fetchLabelsRegistry(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "eth",
        { fetcher: jsonFetcher({}, 500), cache: newMemoryKv() },
      ),
    LabelsRegistryError,
    "HTTP 500",
  );
});

Deno.test("non_json_body_throws", async () => {
  await assertRejects(
    () =>
      fetchLabelsRegistry(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "eth",
        {
          fetcher: textFetcher("<!doctype html><html>..."),
          cache: newMemoryKv(),
        },
      ),
    LabelsRegistryError,
    "not JSON",
  );
});

Deno.test("timeout_throws", async () => {
  // Fetcher that never resolves until the AbortSignal fires.
  const slowFetcher =
    ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as unknown as typeof fetch;

  await assertRejects(
    () =>
      fetchLabelsRegistry(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "eth",
        { fetcher: slowFetcher, timeoutMs: 30, cache: newMemoryKv() },
      ),
    LabelsRegistryError,
    "fetch failed",
  );
});

Deno.test("malformed_entries_are_filtered_out", async () => {
  const fixture = [
    { address: "0xabc", chainId: 1, label: "exchange", nameTag: "Foo" },
    { address: "0xabc", chainId: 1, label: "", nameTag: null },
    null,
    "not-an-object",
    { chainId: 1, nameTag: "no-label-field" },
  ];
  const result = await fetchLabelsRegistry("0xabc", "eth", {
    fetcher: jsonFetcher(fixture),
    cache: newMemoryKv(),
  });
  assertEquals(result.labels.length, 1);
  assertEquals(result.labels[0].label, "exchange");
});

Deno.test("labels_registry: cache returns stored result on second call", async () => {
  const cache = newMemoryKv();
  let fetchCount = 0;
  const fixture = [
    { address: "0xCEX", chainId: 1, label: "exchange", nameTag: "Binance" },
  ];
  const countingFetcher = (async () => {
    fetchCount++;
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const addr = "0xCEX000000000000000000000000000000000000A";
  const r1 = await fetchLabelsRegistry(addr, "eth", {
    fetcher: countingFetcher,
    cache,
  });
  const r2 = await fetchLabelsRegistry(addr, "eth", {
    fetcher: countingFetcher,
    cache,
  });

  assertEquals(r1.labels[0].label, "exchange");
  assertEquals(r2.labels[0].label, "exchange");
  assertEquals(fetchCount, 1);
});
