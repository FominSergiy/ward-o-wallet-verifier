import { assertEquals } from "@std/assert";
import { fetchOfacEthAddresses } from "./ofac_list.ts";

const A1 = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
const A2 = "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("ofac_list: live fetch returns normalized, deduped addresses", async () => {
  const res = await fetchOfacEthAddresses({
    fetchImpl: () =>
      Promise.resolve(
        jsonResponse([A1, A1.toLowerCase(), A2, "not-an-address", ""]),
      ),
    readSeed: () => Promise.resolve([]),
  });

  assertEquals(res.source, "ofac:0xB10C");
  assertEquals(res.addresses.length, 2, "dedupes A1 and drops invalid entries");
  assertEquals(res.addresses.includes(A1.toLowerCase()), true);
  assertEquals(res.addresses.includes(A2.toLowerCase()), true);
});

Deno.test("ofac_list: HTTP error falls back to local seed", async () => {
  const res = await fetchOfacEthAddresses({
    fetchImpl: () => Promise.resolve(jsonResponse({}, 503)),
    readSeed: () => Promise.resolve([A1]),
  });

  assertEquals(res.source, "local-seed");
  assertEquals(res.addresses, [A1.toLowerCase()]);
});

Deno.test("ofac_list: network throw falls back to local seed", async () => {
  const res = await fetchOfacEthAddresses({
    fetchImpl: () => Promise.reject(new Error("network down")),
    readSeed: () => Promise.resolve([A2]),
  });

  assertEquals(res.source, "local-seed");
  assertEquals(res.addresses, [A2.toLowerCase()]);
});

Deno.test("ofac_list: empty live list falls back to seed", async () => {
  const res = await fetchOfacEthAddresses({
    fetchImpl: () => Promise.resolve(jsonResponse([])),
    readSeed: () => Promise.resolve([A1]),
  });
  assertEquals(res.source, "local-seed");
});
