/**
 * One-shot cassette recording script.
 *
 * For each wallet fixture, runs the full verifyAgent pipeline with a fetch
 * interceptor active and writes every HTTP interaction to
 * tests/cassettes/<address>.json.
 *
 * ⚠️  THIS SPENDS REAL MONEY AND TAKES ~10–15 MIN. It makes real x402 paid
 * calls (real USDC), real RPC calls, and real LLM calls. Do NOT run it to make
 * a failing replay test pass — replay tests fail on logic regressions, which
 * you fix in code, not by re-recording. Only re-record when the recorded HTTP
 * traffic itself must change (a service added/removed/reordered, a changed
 * request shape, a changed response schema, or new/changed wallet fixtures).
 * See "Cassettes: replay vs record" in CLAUDE.md for the full cutover rule.
 *
 * Usage: DATABASE_URL="" deno task cassette:record
 * Requires: AGNIC_API_KEY env var + USDC balance + a live network connection.
 * DATABASE_URL must be unset so service selection uses the same offline
 * fallback path as replay; otherwise the recorded set won't match replay.
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { WALLET_FIXTURES } from "../src/fixtures/wallets.ts";
import { verifyAgent } from "../src/agent/verify.ts";
import { defaultLlm } from "../src/agent/llm.ts";
import {
  type Cassette,
  type CassetteEntry,
  installRecordInterceptor,
} from "../src/testing/fetch_interceptor.ts";

const CASSETTES_DIR = join(import.meta.dirname!, "../tests/cassettes");

async function recordWallet(
  address: string,
  label: string,
  expectedVerdict: string,
): Promise<void> {
  console.log(`\n[record] ${label} (${address})`);

  const entries: CassetteEntry[] = [];
  const restore = installRecordInterceptor((entry) => entries.push(entry));

  let verdict: string;
  try {
    const result = await verifyAgent({ address }, { llm: defaultLlm });
    verdict = result.verdict.verdict;
    console.log(
      `  verdict=${verdict} expected=${expectedVerdict} ` +
        (verdict === expectedVerdict ? "✓" : "✗"),
    );
  } finally {
    restore();
  }

  const cassette: Cassette = {
    wallet: address,
    expectedVerdict,
    entries,
  };

  const path = join(CASSETTES_DIR, `${address}.json`);
  await Deno.writeTextFile(path, JSON.stringify(cassette, null, 2));
  console.log(`  wrote ${entries.length} entries → ${path}`);
}

async function main() {
  await ensureDir(CASSETTES_DIR);

  const results: Array<{ label: string; ok: boolean }> = [];
  for (const fixture of WALLET_FIXTURES) {
    try {
      await recordWallet(fixture.address, fixture.label, fixture.expected);
      results.push({ label: fixture.label, ok: true });
    } catch (e) {
      console.error(`  ERROR: ${(e as Error).message}`);
      results.push({ label: fixture.label, ok: false });
    }
    // Brief pause between wallets to avoid triggering rate limits on x402
    // services that share per-IP quotas across the session.
    await new Promise((res) => setTimeout(res, 3_000));
  }

  console.log("\n--- Summary ---");
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.label}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    console.error(`\n${failed} wallet(s) failed to record.`);
    Deno.exit(1);
  }
  console.log(`\nAll ${results.length} cassettes recorded.`);
}

main();
