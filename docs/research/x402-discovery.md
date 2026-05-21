# x402 Discovery — research notes for `resolve.ts` self-discovery

_Research date: 2026-05-21. Sources at the bottom._

## 1. TL;DR

- The Coinbase x402 Bazaar exposes a **public, unauthenticated** discovery API at `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` (paginated catalog) and `…/discovery/search` (semantic search with `query`, `network`, `asset`, `scheme`, `payTo`, `maxUsdPrice` filters). As of this writing the catalog has **~48,000 indexed resources**.
- Because this project pays through the **agnic proxy** (`POST https://api.agnic.ai/api/x402/fetch?url=…`, header `X-Agnic-Token`), the user **does NOT need to fund a USDC-on-Base wallet themselves**. agnic deducts from prepaid credits / its own USDC float and handles EIP-712 signing + settlement. The user's EVM mainnet wallet is irrelevant to runtime payments — verify only that the agnic account has `creditBalance` or `usdcBalance > 0`. If at some later point we ever skip the proxy and use `x402-fetch` directly, **then** the user would need USDC on Base (mainnet `eip155:8453`) or USDC on Base Sepolia (`eip155:84532`) plus a tiny ETH-on-Base gas float — but x402 settlement itself is gasless from the buyer's side (facilitator pays gas).
- Recommended runtime strategy: **boot-time fetch + 5–10 min TTL in-memory cache + LLM-rerank on cache miss**, with graceful fallback to today's `BAZAAR_*_URL` env vars. Per-request live fetch is feasible (the endpoint is fast and unauthenticated) but adds 200–500ms to every verification and pointlessly stresses CDP; the catalog only changes when new services register or quality metrics update (every 6 h).
- **Mapping the 6 plan categories (`sanctions`, `labels`, `onchain_history`, `web_sentiment`, `ens`, `contract_analysis`) → Bazaar entries is best done via the `/discovery/search` semantic endpoint** with a tuned query string per category, then LLM-rerank the top N by `description` + `quality.l30DaysUniquePayers`. Live testing confirmed `?query=OFAC+sanctions+wallet+screening&network=base` returns relevant, ready-to-call resources.
- `ens` should stay free (public RPC + `viem`) — Bazaar is the wrong tool for that.

## 2. The discovery endpoint

### 2.1 URLs and methods

All four routes are documented in [CDP x402 Bazaar docs](https://docs.cdp.coinbase.com/x402/bazaar). Authentication is **not required** for read-only catalog access; CDP API keys are only needed for the facilitator (verify/settle).

| Route | Purpose |
|---|---|
| `GET /platform/v2/x402/discovery/resources` | Paginated catalog dump |
| `GET /platform/v2/x402/discovery/search` | Hybrid semantic + vector + text search |
| `GET /platform/v2/x402/discovery/merchant?payTo=<addr>` | All services that settle to one wallet |
| `GET /platform/v2/x402/discovery/mcp` | MCP server endpoint for agents |

Base: `https://api.cdp.coinbase.com`

### 2.2 Query parameters

`/discovery/resources`
- `type` (string, e.g. `"http"`)
- `limit` (number, default 100, range 20–1000)
- `offset` (number)

`/discovery/search`
- `query` (string, ≤ 400 chars) — free-text, hybrid retrieval
- `network` (string) — CAIP-2 like `eip155:8453`, or legacy alias `base`
- `asset` (string, case-insensitive, e.g. `USDC` or a token address)
- `scheme` (string) — `exact` or `upto`
- `payTo` (string)
- `maxUsdPrice` (string float, e.g. `"0.01"`)
- `extensions` (array)
- `limit` (integer, max 20)

`/discovery/merchant`
- `payTo` (required, EVM `0x…` or Solana base58)
- `limit` (default 25, max 100), `offset` (default 0)

### 2.3 Response schema (live-verified)

Top level of `/discovery/resources`:

```json
{
  "items": [ /* DiscoveryEntry[] */ ],
  "pagination": { "limit": 100, "offset": 0, "total": 48030 },
  "x402Version": 2
}
```

A `DiscoveryEntry` from the live response:

```json
{
  "resource": "https://api.oatp.cc/tools/tx_explainer",
  "type": "http",
  "x402Version": 2,
  "lastUpdated": "2026-05-14T14:26:42.878Z",
  "description": "OATP · tx_explainer — Fetch a Solana transaction by signature and return a human-readable explanation…",
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "100000",
      "payTo": "0x5d6dF6b10C54617dac4Bf9993ad9fA384b7B36d3",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USD Coin", "version": "2" }
    },
    { /* same resource also accepts USDC on Solana */ }
  ],
  "extensions": {
    "bazaar": {
      "info": { "input": { "method": "POST", "bodyType": "json", "body": {…} },
                "output": { "type": "json", "example": {…} } },
      "schema": { "$schema": "https://json-schema.org/draft/2020-12/schema", …}
    }
  },
  "quality": {
    "l30DaysTotalCalls": 18653,
    "l30DaysUniquePayers": 2598,
    "lastCalledAt": "2026-05-14T14:26:42.685Z"
  }
}
```

Search-endpoint envelope is slightly different:

```json
{
  "resources": [ /* same shape, ordered by relevance */ ],
  "searchMethod": "hybrid",  // | "vector" | "text"
  "partialResults": true,
  "x402Version": 2
}
```

Key observations from live data:
- `accepts[].amount` is **atomic units** (USDC has 6 decimals → `"100000"` = $0.10).
- The token at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` is **USDC on Base mainnet** (chain `eip155:8453`); same address shows up across virtually every EVM entry.
- Many entries dual-list USDC on Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) — we can ignore those, agnic + this project are EVM-only today.
- `quality.l30DaysUniquePayers` is a usable trust/popularity signal for rerank.
- Some entries (especially from `orbisapi.com` / `cortex402` / `payai`) embed richer `outputSchema`, `category`, `description`, `facilitator`, `maxAmountRequiredUSD` fields on individual `accepts` entries — schema is loosely-typed in practice.

### 2.4 Rate limits

Not documented publicly. The endpoint is on Cloudflare and answered fast under hand testing. Treat as best-effort and add client-side throttling.

### 2.5 How services get listed

From CDP docs: there is **no separate registration step**. The CDP Facilitator catalogs an endpoint the first time it **settles** a payment for it. Bazaar caches results with up to ~10 min reflection lag; quality metrics recompute every 6 h. Bazaar also normalizes URLs whose path segments are high-cardinality identifiers (UUID, ETH/Solana address, tx hash) — so `…/wallet/0xabc…/score` and `…/wallet/0xdef…/score` collapse to one entry.

## 3. Payment model & the ETH-only-wallet question

**Short answer for the user: with the current agnic-proxy architecture you don't need to touch your wallet at all.**

### 3.1 Why the agnic proxy decouples your wallet from x402

Look at `src/clients/agnic.ts`. Every paid call is `POST https://api.agnic.ai/api/x402/fetch?url=<target>` with header `X-Agnic-Token: $AGNIC_API_KEY`. Agnic's server:

1. Receives the upstream `402 Payment Required` challenge from the x402 service,
2. EIP-712-signs the payment authorization with **agnic's** USDC-on-Base wallet,
3. Posts to the facilitator, gets verified/settled, retries the original request with the `X-Payment` header,
4. Returns the response to us along with `X-Agnic-Paid`, `X-Agnic-Amount`, `X-Agnic-Network`, `X-Agnic-Scheme` headers.

We pay agnic out of our prepaid credit balance (`creditBalance` field on `GET /api/balance`). The user's personal EVM wallet **is not used at any point** in this flow.

**Action items for the user, in priority order:**

1. Run `curl https://api.agnic.ai/api/balance -H "X-Agnic-Token: $AGNIC_API_KEY"` and confirm `creditBalance` is non-zero. Sample CLAUDE.md output shows `49.9999` — fine for thousands of $0.001 calls.
2. Optionally top up agnic credits via their dashboard.
3. **You can stop here.** The next two sections are only useful if we ever rip out the proxy and use `x402-fetch` natively.

### 3.2 If we ever bypassed agnic — what funding you'd need

x402's settlement is gasless from the buyer side (the facilitator submits the on-chain `transferWithAuthorization`). You'd need:

- **USDC on Base mainnet** at chain `eip155:8453`, token `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — for paying production resources.
- **USDC on Base Sepolia** at chain `eip155:84532`, token `0x036CbD53842c5426634e7929541eC2318f3dCF7e` — for testing against `https://x402.org/facilitator`.
- **ETH on Base mainnet** — only if you want a self-relay fallback; not needed when using a facilitator.
- USDC-on-Ethereum-mainnet (`0xA0b86…48`) is **not** what x402 currently uses by default.

### 3.3 How to check your EVM wallet contents (assume `$ADDR` is your 0x…)

Pick whichever you prefer; all are read-only.

**Option A — Block explorers (zero-install):**
- ETH mainnet balance (ETH + ERC-20 list): `https://etherscan.io/address/<ADDR>`
- Base mainnet balance: `https://basescan.org/address/<ADDR>`
- Base Sepolia balance: `https://sepolia.basescan.org/address/<ADDR>`
- USDC token tab on Etherscan: `https://etherscan.io/token/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48?a=<ADDR>`
- USDC-on-Base token tab: `https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?a=<ADDR>`

**Option B — Foundry `cast` (one liner each):**

```bash
# ETH balance on Ethereum mainnet (formatted to ether)
cast balance --rpc-url https://eth.llamarpc.com $ADDR --ether

# ETH balance on Base mainnet
cast balance --rpc-url https://mainnet.base.org $ADDR --ether

# USDC on Ethereum mainnet (6 decimals)
cast call --rpc-url https://eth.llamarpc.com \
  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  "balanceOf(address)(uint256)" $ADDR

# USDC on Base mainnet
cast call --rpc-url https://mainnet.base.org \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  "balanceOf(address)(uint256)" $ADDR

# USDC on Base Sepolia
cast call --rpc-url https://sepolia.base.org \
  0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  "balanceOf(address)(uint256)" $ADDR
```

Divide USDC results by `10^6` to get human dollars.

**Option C — viem (matches our project stack, runnable in Deno):**

```ts
import { createPublicClient, http, formatUnits, erc20Abi } from "npm:viem";
import { mainnet, base, baseSepolia } from "npm:viem/chains";

const ADDR = "0x..." as const;
const USDC = {
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  base:     "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  baseSep:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const;

for (const [chain, usdc] of [
  [mainnet, USDC.ethereum], [base, USDC.base], [baseSepolia, USDC.baseSep],
] as const) {
  const c = createPublicClient({ chain, transport: http() });
  const nativeWei = await c.getBalance({ address: ADDR });
  const usdcAtomic = await c.readContract({
    address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [ADDR],
  });
  console.log(chain.name, "native=", formatUnits(nativeWei, 18),
                          "USDC=", formatUnits(usdcAtomic, 6));
}
```

## 4. Real-time discovery: pros / cons / alternatives

The catalog is large (~48k entries) but each `/search` response is bounded (≤ 20 results) and entries change on the order of minutes, not seconds. That shapes the tradeoffs:

| Option | Latency / req | Freshness | Cost (calls/day) | Rate-limit risk | Complexity | Verdict |
|---|---|---|---|---|---|---|
| **(a)** Live `/search` per verification, no cache | +200–500 ms × N categories | Fresh-est | High (categories × verifications) | Real if traffic spikes | Lowest | Fine for hackathon demo, wasteful at scale |
| **(b)** Live `/search` + LLM rerank per request | +800–1500 ms (LLM call) | Fresh-est | High + LLM tokens | Same as (a) plus OpenRouter spend | Medium | Only if rerank quality matters |
| **(c)** Periodic refresh (e.g. cron every 10 min) | ~0 ms (memory) | ≤ 10 min stale | Low (6/h × 6 categories = 36/h) | Negligible | Medium (needs scheduler) | Best for long-running prod |
| **(d)** Boot-time fetch + cache for process lifetime | ~0 ms | Stale until restart | Lowest | None | Lowest | Risky for long-lived processes; great for short-lived workers |
| **(e)** Hybrid: cache catalog, re-resolve on call failure | ~0 ms hot / +300 ms cold | Self-healing | Low | Negligible | Highest | **Recommended** for this project |

**Recommended for this project: option (e) tuned as (c)+(e):** boot-time fetch, in-memory cache keyed by category with a 10 min TTL refresh in the background, **plus** invalidation on 402-not-served / 5xx from a resolved provider so a single failed call refetches that category and tries the next-best service. Falls back to the env-var endpoints in today's `resolve.ts` if Bazaar itself is unreachable.

## 5. Mapping discovery results to `plan.ts` categories

The categories in `src/agent/types.ts` / `plan.ts` are: `sanctions`, `labels`, `onchain_history`, `web_sentiment`, `ens`, `contract_analysis`.

### 5.1 Recommended: keyword query → top-N → LLM rerank, with `ens` excluded

For each category, hit `/discovery/search` with a hand-tuned query and EVM-only filter. Then keep the top N candidates by relevance, and (only if N > 1) ask the LLM to pick the best one with `description` + recent-usage as context.

Live-tested queries that returned good matches:

| Category | Query string | Sample top result (live) |
|---|---|---|
| `sanctions` | `OFAC sanctions wallet screening` (+ `network=base`) | `cortex402-sanctions-screen` — OFAC/UN/EU screen, $0.01 USDC on Base, also returns `orbisapi.com` SDN screener with full `outputSchema` |
| `labels` | `wallet address entity label nansen etherscan` | (test before shipping; not pre-verified above) |
| `onchain_history` | `wallet transactions history etherscan` | `api.strale.io/x402/wallet-transactions-lookup` — Etherscan V2 transactions, 0.0216 USDC on Base |
| `web_sentiment` | `news mentions sentiment wallet address` | (test before shipping) |
| `contract_analysis` | `smart contract risk audit analysis EVM` | (test before shipping) |
| `ens` | _skip_ | use `viem` + public RPC, free |

`accepts[]` is the source of truth for cost and chain — filter to entries with `accepts[].network ∈ {eip155:8453, base}` and `extra.name === "USD Coin"` (or address `0x833589…2913`) before scoring.

### 5.2 Alternatives considered

- **Tag-based filtering** — some entries set `category` and `tags` inside `extensions.bazaar`, but population is inconsistent (the OATP entries don't, the orbisapi/cortex402 entries do). Tags alone won't give us full coverage.
- **Embedding similarity over `description`** — we'd embed each `description` and store vectors; overkill given that `/discovery/search` already runs hybrid retrieval server-side (`searchMethod: "hybrid"`).
- **Curated allowlist** — pin a known-good `resource` URL per category in env. This is what we have today; keep it as the fallback layer.

## 6. Recommended implementation sketch

Illustrative only — **do not paste into the repo**. Sits in front of `src/agent/resolve.ts`:

```ts
// src/clients/discovery.ts (sketch)

const BASE = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";
const TTL_MS = 10 * 60 * 1000;

interface AcceptsItem {
  scheme: "exact" | "upto";
  network: string;
  asset: string;
  amount: string;          // atomic USDC (6 decimals)
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string };
}
interface DiscoveryEntry {
  resource: string;
  type: "http";
  x402Version: number;
  description?: string;
  accepts: AcceptsItem[];
  lastUpdated: string;
  quality?: { l30DaysUniquePayers?: number; l30DaysTotalCalls?: number };
}

const cache = new Map<Category, { at: number; entries: DiscoveryEntry[] }>();

const QUERIES: Record<Exclude<Category, "ens">, string> = {
  sanctions: "OFAC sanctions wallet screening",
  labels: "wallet address entity label",
  onchain_history: "wallet transactions history etherscan",
  web_sentiment: "news sentiment mentions wallet address",
  contract_analysis: "smart contract risk audit EVM",
};

export async function discoverServices(
  category: Exclude<Category, "ens">,
  chain: Chain,                     // "ethereum" | "base" | "base-sepolia"
): Promise<DiscoveryEntry[]> {
  const hit = cache.get(category);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.entries;

  const network = chain === "base-sepolia" ? "eip155:84532" : "eip155:8453";
  const url = new URL(`${BASE}/search`);
  url.searchParams.set("query", QUERIES[category]);
  url.searchParams.set("network", network);
  url.searchParams.set("asset", "USDC");
  url.searchParams.set("limit", "10");

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`discovery ${r.status}`);
    const json = await r.json() as { resources: DiscoveryEntry[] };
    const filtered = json.resources
      .filter((e) => e.accepts.some((a) =>
        a.network === network && a.scheme === "exact"))
      .sort((a, b) =>
        (b.quality?.l30DaysUniquePayers ?? 0) -
        (a.quality?.l30DaysUniquePayers ?? 0));
    cache.set(category, { at: Date.now(), entries: filtered });
    return filtered;
  } catch (err) {
    // graceful fallback: synthesize an Entry from the env-var endpoint
    const envUrl = Deno.env.get(ENDPOINT_ENV_MAP[category]);
    if (!envUrl) throw err;
    return [{
      resource: envUrl,
      type: "http",
      x402Version: 2,
      description: `env-fallback for ${category}`,
      accepts: [],
      lastUpdated: new Date().toISOString(),
    }];
  }
}

// Call-site: pick first viable entry, derive cost from accepts[].amount
export async function resolveBazaarEndpoints(
  categories: Category[],
  chain: Chain,
): Promise<Call[]> {
  const calls: Call[] = [];
  for (const cat of categories) {
    if (cat === "ens") { calls.push(ENS_CALL); continue; }
    const [best] = await discoverServices(cat, chain);
    if (!best) continue;
    const usdcAccepts = best.accepts.find((a) => a.extra?.name === "USD Coin");
    calls.push({
      category: cat,
      phase: 1,
      provider: new URL(best.resource).hostname,
      endpoint: best.resource,
      estimatedCostUsdc: usdcAccepts
        ? Number(usdcAccepts.amount) / 1_000_000
        : 0,
    });
  }
  return calls;
}
```

Failure modes covered:
- Discovery down → env-var fallback path.
- Discovery returns nothing for a category → skip the category (planner can re-decide).
- Provider returns 5xx at call-time → invalidate that category's cache and retry with the next-ranked entry (caller's responsibility, not shown).

## 7. Open questions / risks

- **Rate limits** on `/discovery/*` are not documented. Conservatively cap to ~10/min during dev. ([CDP Bazaar docs](https://docs.cdp.coinbase.com/x402/bazaar))
- **`category` field inconsistency**: some entries put a `category` inside `accepts[]` (e.g. `"compliance"`), others put tags inside `extensions.bazaar`, many have neither. We must not rely on a single canonical field.
- **`x402Version: 2`** is on every entry today, but the public x402 GitHub readme references package names like `@x402/core`, `@x402/fetch`, `@x402/evm` etc. — different from the `x402-fetch`, `x402-axios` names in older Coinbase blog posts. Suggests a package rename happened. Verify exact package names before adding a dependency.
- **Quality signal trustworthiness**: `quality.l30DaysUniquePayers` can be gamed. For sanctions/compliance especially, we should hard-allowlist a small set of providers (orbisapi, cortex402) rather than blindly trust the top-ranked Bazaar hit.
- **Solana entries** show up in mixed-network results; filter them out in code.
- We were unable to fetch the `coinbase/x402` package READMEs directly (404 for the `main` branch path). Confirm the canonical TS package name before importing.
- **Asset diversity**: x402 protocol-wise supports any ERC-20 via Permit2 (per quickstart-for-sellers docs), but in practice the live catalog is 99%+ USDC. Safe to assume USDC-only for now.

## 8. Sources

- [CDP x402 Bazaar (Discovery Layer) docs](https://docs.cdp.coinbase.com/x402/bazaar) — primary source for endpoint URLs, params, response schema, indexing model, URL normalization.
- [CDP x402 Quickstart for Sellers](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers) — supported networks (CAIP-2 IDs), accepted assets, `exact` vs `upto` schemes, facilitator role.
- Live fetch of `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` — confirmed response shape, schema, USDC-on-Base as default asset, ~48k total entries.
- Live fetch of `https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=OFAC+sanctions+wallet+screening&network=base` — confirmed semantic search works without auth and returns ready-to-call sanctions providers.
- [Introducing x402 Bazaar (Coinbase blog)](https://www.coinbase.com/developer-platform/discover/launches/x402-bazaar) — context on Bazaar positioning as a search engine for agents.
- [Introducing x402 (Coinbase blog)](https://www.coinbase.com/developer-platform/discover/launches/x402) — protocol overview.
- [APIs That Get Paid: Monetizing the Agentic Internet (Coinbase)](https://www.coinbase.com/developer-platform/discover/launches/monetize-apis-on-x402) — seller-side framing of Bazaar discovery.
- [Agentic.Market launch (Coinbase)](https://www.coinbase.com/developer-platform/discover/launches/agentic-market) — public-facing directory; complements but does not replace the API.
- [coinbase/x402 GitHub README](https://github.com/coinbase/x402) — package list (`@x402/core`, `@x402/fetch`, etc.), network coverage.
- [x402.org](https://www.x402.org) — protocol homepage; lighter on technical detail than CDP docs.
- [HeimLabs: Ship a 402-Powered API with Bazaar (Medium)](https://medium.com/@heimlabs/ship-a-402-powered-api-bazaar-with-x402-from-discovery-to-paid-response-in-one-script-cf08f3853b05) — narrative walkthrough; cross-checked discovery URL.
- Project files: `src/clients/agnic.ts`, `src/agent/resolve.ts`, `src/agent/plan.ts`, `CLAUDE.md` — confirmed agnic-proxy flow and current hardcoded endpoint mapping.
