/**
 * Cassette-based regression tests for verifyAgent.
 *
 * Each test loads a pre-recorded cassette for a fixture wallet, installs the
 * replay fetch interceptor, runs the full verifyAgent pipeline, and asserts
 * the verdict matches the expected value — all offline, no paid calls.
 *
 * Run: deno task test:replay
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { WALLET_FIXTURES } from "../src/fixtures/wallets.ts";
import { verifyAgent } from "../src/agent/verify.ts";
import { defaultLlm } from "../src/agent/llm.ts";
import {
  type Cassette,
  installReplayInterceptor,
} from "../src/testing/fetch_interceptor.ts";

const CASSETTES_DIR = join(import.meta.dirname!, "cassettes");

// All fetch calls are intercepted by the cassette replayer, so the real key
// is never sent. We still need a non-empty value to satisfy the pre-fetch
// guard in agnicFetch / gateway.ts / detectWalletNetwork.
Deno.env.set("AGNIC_API_KEY", "cassette-replay-dummy");

async function loadCassette(address: string): Promise<Cassette> {
  const path = join(CASSETTES_DIR, `${address}.json`);
  const text = await Deno.readTextFile(path);
  return JSON.parse(text) as Cassette;
}

for (const fixture of WALLET_FIXTURES) {
  Deno.test({
    name: `replay: ${fixture.label} (${fixture.address}) → ${fixture.expected}`,
    async fn() {
      const cassette = await loadCassette(fixture.address);

      const restore = installReplayInterceptor(cassette.entries);
      try {
        const result = await verifyAgent(
          { address: fixture.address },
          { llm: defaultLlm },
        );
        assertEquals(
          result.verdict.verdict,
          fixture.expected,
          `expected verdict=${fixture.expected}, got ${result.verdict.verdict}`,
        );
      } finally {
        restore();
      }
    },
    // Ensure no real network calls slip through — replay interceptor throws on
    // unknown requests, but sanitizeOps catches any lingering open resources.
    sanitizeOps: true,
    sanitizeResources: false,
  });
}
