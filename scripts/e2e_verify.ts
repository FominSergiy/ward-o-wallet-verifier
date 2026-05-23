// End-to-end validation against a reference set of real mainnet wallets.
// Etherscan ground truth was captured at plan time; expectations encode the
// minimum bar our verifier must clear. Run against a locally-running dev
// server (or a remote URL via VERIFY_BASE_URL).
//
//   ~/.deno/bin/deno task dev          # in one shell
//   ~/.deno/bin/deno task verify:e2e   # in another
//
// Exits non-zero on the first expectation that fails so this can be wired
// into CI later if desired.

interface Expectation {
  address: string;
  label: string;
  groundTruth: string;
  allowedVerdicts: ReadonlyArray<"safe_to_transact" | "do_not_transact" | "insufficient_data">;
  expectedSafe?: boolean; // omit when verdict alone is the contract
  notes?: string;
}

// Expectations are written against the WORST-CASE behavior the system must
// guarantee given the current Bazaar service catalog. Specifically:
//   • Sanctioned wallets MUST be flagged do_not_transact (the sanctions
//     service is the load-bearing signal here).
//   • Phishing-flagged wallets MUST NOT be marked safe_to_transact — this is
//     the gap fix; if a phishing-DB service is in the catalog we may even
//     reach do_not_transact, but at minimum insufficient_data is acceptable.
//   • Verifiably-clean wallets (CEX, doxxed-ENS) MUST NOT be flagged
//     do_not_transact (false-positive guard). The system MAY land on
//     insufficient_data when the available label/ENS services don't surface
//     a positive identity confirmation for these specific addresses — that
//     reflects an honest catalog-coverage limit, not a verdict bug. Reaching
//     safe_to_transact for them requires a label provider that knows the
//     address (or wiring ENS into DEFAULT_CATEGORIES as a follow-up).
const WALLETS: Expectation[] = [
  {
    address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96",
    label: "Ronin Bridge Exploiter (Lazarus)",
    groundTruth: "Etherscan: OFAC-Sanctioned, Blocked by USDC/USDT issuer",
    allowedVerdicts: ["do_not_transact"],
    expectedSafe: false,
    notes: "Hard regression guard for sanctions screening — must always flag.",
  },
  {
    address: "0xfb6E71e0800BcCC0db8a9Cf326fe3213CA1A0EA0",
    label: "Fake_Phishing201479 (GoPlus-reported)",
    groundTruth: "Etherscan: Fake_Phishing201479 — Phish/Hack",
    allowedVerdicts: ["do_not_transact", "insufficient_data"],
    expectedSafe: false,
    notes: "Gap-closure check — never safe_to_transact regardless of POIC discovery outcome.",
  },
  {
    address: "0xF977814e90dA44bFA03b6295A0616a897441aceC",
    label: "Binance Hot Wallet 20",
    groundTruth: "Etherscan: Binance: Hot Wallet 20 (clean labeled CEX)",
    allowedVerdicts: ["safe_to_transact", "insufficient_data"],
    notes: "False-positive guard — must NOT flag do_not_transact. safe_to_transact requires the catalog's label service to surface a CEX attribution.",
  },
  {
    address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    label: "vitalik.eth",
    groundTruth: "Etherscan: vitalik.eth (public figure, clean, doxxed ENS)",
    allowedVerdicts: ["safe_to_transact", "insufficient_data"],
    notes: "False-positive guard — must NOT flag do_not_transact. safe_to_transact path requires ENS reverse-resolution which is not yet in DEFAULT_CATEGORIES.",
  },
];

const BASE_URL = Deno.env.get("VERIFY_BASE_URL") ?? "http://localhost:8000";
const TIMEOUT_MS = parseInt(Deno.env.get("VERIFY_TIMEOUT_MS") ?? "180000");

interface VerifyResponse {
  verdict?: {
    verdict?: string;
    safe?: boolean;
    confidence?: string;
    headline?: string;
    reasoning?: string;
  };
  synthesisError?: string;
  receipts?: Array<{ category: string; status: string; resource: string }>;
  error?: string;
  message?: string;
}

async function runOne(exp: Expectation): Promise<{ pass: boolean; detail: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/verify-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: exp.address, chain: "eth" }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    return { pass: false, detail: `request failed: ${(e as Error).message}` };
  }
  clearTimeout(t);
  if (!res.ok) {
    const body = await res.text();
    return { pass: false, detail: `HTTP ${res.status}: ${body.slice(0, 400)}` };
  }
  const json = await res.json() as VerifyResponse;
  if (!json.verdict) {
    return { pass: false, detail: `no verdict in response: ${JSON.stringify(json).slice(0, 400)}` };
  }
  const got = json.verdict;
  const verdictOk = exp.allowedVerdicts.includes(got.verdict as typeof exp.allowedVerdicts[number]);
  const safeOk = exp.expectedSafe === undefined ? true : got.safe === exp.expectedSafe;
  // Receipts use status="ok" on success; treat any non-empty success-like
  // status as resolved for display purposes only (assertion already covered
  // by verdict).
  const resolvedCategories = json.receipts
    ?.filter((r) => r.status === "ok" || r.status === "success")
    .map((r) => r.category)
    .join(",") ?? "";
  const detail =
    `verdict=${got.verdict} safe=${got.safe} confidence=${got.confidence} ` +
    `resolved=[${resolvedCategories}] headline="${(got.headline ?? "").slice(0, 140)}"`;
  return { pass: verdictOk && safeOk, detail };
}

async function main(): Promise<number> {
  console.log(`[e2e] base url: ${BASE_URL}`);
  console.log(`[e2e] running ${WALLETS.length} wallet checks (timeout ${TIMEOUT_MS}ms each)\n`);
  let failed = 0;
  for (const exp of WALLETS) {
    const allowed = exp.allowedVerdicts.join("|");
    console.log(`▶ ${exp.label}`);
    console.log(`  addr=${exp.address}`);
    console.log(`  truth=${exp.groundTruth}`);
    console.log(`  expect: verdict ∈ {${allowed}}  safe=${exp.expectedSafe}`);
    const result = await runOne(exp);
    if (result.pass) {
      console.log(`  ✓ PASS — ${result.detail}\n`);
    } else {
      failed++;
      console.log(`  ✗ FAIL — ${result.detail}\n`);
    }
  }
  console.log(`[e2e] ${WALLETS.length - failed}/${WALLETS.length} passed`);
  return failed === 0 ? 0 : 1;
}

const code = await main();
Deno.exit(code);
