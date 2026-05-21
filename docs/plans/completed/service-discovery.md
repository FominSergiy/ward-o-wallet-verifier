# Service Discovery — Implementation Plan

**Scope:** discovery only. This plan ends at "we have a ranked, costed shortlist of x402 services per category, formatted for downstream plan-view." Calling the services and aggregating findings is out of scope.

**Grounding docs:**
- Research: [docs/research/x402-discovery.md](../docs/research/x402-discovery.md)
- Categories live in [src/agent/types.ts](../src/agent/types.ts) (`Category` enum)
- Current static category→endpoint map in [src/agent/resolve.ts](../src/agent/resolve.ts) (the thing this feature eventually replaces)
- Payment proxy in [src/clients/agnic.ts](../src/clients/agnic.ts) (used only by *downstream* phases, not by discovery itself — discovery is read-only and unauthenticated)

---

## 0. Recommendation: Option A (programmatic queries → LLM rerank) over Option B (LLM-driven discovery)

You asked me to recommend between:
- **A**: pre-defined queries → parallel calls to `GET /discovery/search` → aggregate results → single LLM call to rank/select
- **B**: one LLM call given the categories + endpoint URL, asks LLM to return the service list directly

**Pick A.** Reasons:

| Dimension | A: programmatic | B: LLM-driven |
|---|---|---|
| Discovery quality | `/discovery/search` already runs *hybrid semantic search server-side* — we get embedding-grade matching for free | LLM has to either be fed the 48k-entry catalog (impossible) or call the endpoint as a tool (multi-turn, slow, expensive) |
| Determinism | Same inputs → same shortlist. Testable with VCR/snapshot. | LLM picks vary across runs; flaky tests. |
| Cost per discovery | 1 LLM call (rerank ~30 entries) | 3–5 LLM tool-call turns + larger context |
| Latency | N parallel HTTP fetches (~300 ms total) + 1 LLM call | LLM tool-call loop is sequential, multi-second |
| Failure modes | If LLM is down → degrade to "unranked shortlist by `quality.l30DaysUniquePayers`". If discovery is down → fall back to env-var endpoints in `resolve.ts`. | LLM is on the critical path twice. Either failure = no shortlist. |
| Halluc. risk | None — only real entries returned by CDP API enter the pipeline | LLM may invent URLs or prices that don't exist in the catalog |
| Pagination | Trivial — `limit` param + offset | LLM has to reason about pagination, often skips entries |
| Debugging | Each layer (query, fetch, rank) is independently inspectable in logs | Opaque LLM tool-call transcript |

**Where the LLM still earns its keep:** the *ranking* step (step 5 below). After the deterministic fetch returns ~5–10 candidates per category, the LLM weighs recency (`quality.l30DaysUniquePayers`), price, description-fit, and `payTo`-trust signals into a single shortlist. That's a small, bounded, judgment-heavy task — exactly what LLMs are good at.

---

## 1. End-to-end pipeline

```
address (input)
  │
  ▼
[D-1] detectWalletNetwork(address)  ────►  walletNetwork: "base" | "base-sepolia"
  │
  ▼
[D-3] buildCategoryQueries(categories) ──► Record<Category, string>
  │
  ▼
[D-4] fetchDiscoveryCandidates(queries, walletNetwork)
        │
        ├─ uses [D-2] discovery client
        │
        ▼  Record<Category, DiscoveryEntry[]>  (raw candidates, 5–10 per category)
  │
  ▼
[D-5] rankServices(candidates)  ──► Record<Category, RankedService>
  │
  ▼
[D-6] formatPlan(rankedSelections) ──► DiscoveryPlan { services, totalEstimatedCostUsdc, walletNetwork }
  │
  ▼
served by POST /discover  (also the e2e test target)
```

Six tickets follow. Each is independently shippable and testable. Tickets must be implemented in order — D-1 through D-4 are pure HTTP and can land back-to-back; D-5 depends on the schema D-4 returns; D-6 wires it all together.

---

## D-1: Wallet network detector

**Why:** Discovery `network` filter takes CAIP-2 values (`eip155:8453` for Base mainnet, `eip155:84532` for Sepolia). We must know which one to pass before any discovery call. The agnic balance endpoint reveals this via the `?network=base` query param — when omitted, it returns the sepolia wallet; when set to `base`, it returns the mainnet wallet (verified in this conversation).

**Files:**
- `src/discovery/network.ts` (new) — exports `detectWalletNetwork(): Promise<WalletNetwork>` and the `WalletNetwork = "base" | "base-sepolia"` type.
- `src/discovery/network_test.ts` (new)

**Logic:**
1. Call `GET https://api.agnic.ai/api/balance?network=base` with `X-Agnic-Token` header.
2. If `parseFloat(usdcBalance) > 0`, return `"base"`.
3. Otherwise call `GET https://api.agnic.ai/api/balance` (no param → returns sepolia wallet), check `usdcBalance > 0`, return `"base-sepolia"`.
4. If neither has balance, throw `WalletUnfundedError` with a clear message telling the user to top up either mainnet or testnet USDC. The error carries both wallet addresses for the caller to display.

**CAIP-2 mapping** (live in the same module): `"base" → "eip155:8453"`, `"base-sepolia" → "eip155:84532"`. Exported as `toCaip2(net: WalletNetwork): string`.

**Acceptance criteria:**
- `detectWalletNetwork()` returns `"base"` when only the mainnet endpoint shows USDC, `"base-sepolia"` when only the default endpoint shows USDC.
- When both have USDC, it returns `"base"` (prefer mainnet — that's where real services live).
- When neither has USDC, it throws `WalletUnfundedError` whose message includes both wallet addresses.
- `toCaip2("base") === "eip155:8453"` and `toCaip2("base-sepolia") === "eip155:84532"`.

**Test spec** (`network_test.ts`):
- `detectWalletNetwork prefers mainnet when both wallets are funded` — fixture: both `/api/balance` and `/api/balance?network=base` return `usdcBalance: "0.5"`. Asserts `"base"`.
- `detectWalletNetwork returns sepolia when only sepolia funded` — fixture: default funded, mainnet returns `usdcBalance: "0"`. Asserts `"base-sepolia"`.
- `detectWalletNetwork returns base when only mainnet funded` — fixture: opposite of above. Asserts `"base"`.
- `detectWalletNetwork throws WalletUnfundedError when neither funded` — both endpoints return `"0"`. Asserts error type + that error.message contains both wallet addresses.
- `toCaip2 maps both network values` — pure assertion.

Mock the agnic API with a `fetch` stub injected via a `fetchFn` parameter (default = global `fetch`), same pattern as `agnic.ts`.

**Validation commands:**
```bash
~/.deno/bin/deno check src/discovery/network.ts src/discovery/network_test.ts
~/.deno/bin/deno lint src/discovery/network.ts src/discovery/network_test.ts
~/.deno/bin/deno test --allow-env src/discovery/network_test.ts
```

---

## D-2: CDP discovery client

**Why:** A typed wrapper around `GET /platform/v2/x402/discovery/search` so the rest of the codebase never deals with raw fetch + JSON parsing of CDP responses.

**Files:**
- `src/discovery/client.ts` (new)
- `src/discovery/client_test.ts` (new)
- `src/discovery/types.ts` (new) — shared discovery types

**Types** (in `types.ts`, derived from the live response shape — see research doc §2):
```ts
export interface DiscoveryAccept {
  amount: string;          // microUSDC, parsed to number at use site
  asset: string;           // contract address; USDC on Base = 0x833589...
  network: string;         // CAIP-2
  payTo: string;
  scheme: "exact" | "upto";
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string };
}

export interface DiscoveryEntry {
  resource: string;        // URL of the service
  description: string;
  accepts: DiscoveryAccept[];
  extensions?: {
    bazaar?: {
      info?: { method: string; queryParams?: unknown; bodyType?: string };
      quality?: { l30DaysUniquePayers?: number };
    };
  };
}

export interface SearchParams {
  query: string;
  network: string;           // CAIP-2
  maxUsdPrice?: number;
  limit?: number;            // default 10, max 20
}
```

**Public function:** `searchDiscovery(params: SearchParams, fetchFn?): Promise<DiscoveryEntry[]>`
- Builds the URL with `URLSearchParams`.
- Returns `resources` array, filtered to entries that have at least one `accepts[]` matching the requested CAIP-2 network (the API sometimes returns Solana co-listings).
- On HTTP non-2xx, throws `DiscoveryFetchError` with status + URL.
- On empty results, returns `[]` (not an error — caller decides what to do).

**Acceptance criteria:**
- Builds the correct URL for a representative call (snapshot test).
- Filters out entries whose `accepts[]` doesn't include the requested network.
- Returns `[]` cleanly when the API returns no resources.
- Throws `DiscoveryFetchError` on 5xx, with status code and URL embedded in the message.
- No `any` types; all inputs/outputs typed via zod or interfaces.

**Test spec** (`client_test.ts`):
- `searchDiscovery builds correct URL with all params` — fetchFn stub captures URL, asserts query string contains `query`, `network`, `maxUsdPrice`, `limit`.
- `searchDiscovery filters out off-network entries` — fixture returns 3 entries, only 2 with `eip155:8453`. Assert length 2.
- `searchDiscovery returns empty array on no results` — fixture `{resources: [], ...}` → asserts `[]`.
- `searchDiscovery throws DiscoveryFetchError on 500` — fetchFn returns `{status: 500}`. Asserts error type and message.
- `searchDiscovery throws on malformed JSON` — fetchFn returns invalid body. Asserts a parse error surfaces.

**Validation commands:**
```bash
~/.deno/bin/deno check src/discovery/client.ts src/discovery/client_test.ts src/discovery/types.ts
~/.deno/bin/deno lint src/discovery/client.ts src/discovery/client_test.ts src/discovery/types.ts
~/.deno/bin/deno test src/discovery/client_test.ts
```

---

## D-3: Category → query map

**Why:** Per-category hand-tuned query strings. Hand-tuned beats generic because semantic search responds well to domain-specific phrasing (verified in research: `"wallet address sanctions risk screening"` returned the right providers; `"wallet"` alone did not).

**Files:**
- `src/discovery/queries.ts` (new)
- `src/discovery/queries_test.ts` (new)

**Public:**
```ts
export const CATEGORY_QUERIES: Record<Exclude<Category, "ens">, string> = {
  sanctions: "wallet address sanctions OFAC AML screening",
  labels: "wallet address entity label identification attribution",
  onchain_history: "ethereum wallet transaction history tx count balance",
  web_sentiment: "web search news social mentions scam exploit",
  contract_analysis: "smart contract address source code audit security analysis",
};

export function queriesForCategories(categories: Category[]): Record<string, string> {
  // returns map of category → query, omitting "ens" (handled out-of-band)
}
```

**Why ENS is excluded:** ENS reverse lookup is a free `viem` public-RPC call (already noted in `resolve.ts:12`); no x402 service needed. Discovery skips it entirely.

**Acceptance criteria:**
- `queriesForCategories(["sanctions","ens","labels"])` returns `{sanctions: "...", labels: "..."}` — exactly two entries, no "ens" key.
- Throws if the input contains an unknown category (caught by TS, but a runtime guard for defensive use from JSON).
- Every category in the enum *except* ens has a non-empty query string.

**Test spec:**
- `every non-ens category has a query` — iterate enum, assert.
- `queriesForCategories drops ens` — assert key absence.
- `queriesForCategories preserves order` — assert returned key order matches input order (matters for the downstream rerank).

**Validation commands:**
```bash
~/.deno/bin/deno check src/discovery/queries.ts src/discovery/queries_test.ts
~/.deno/bin/deno lint src/discovery/queries.ts src/discovery/queries_test.ts
~/.deno/bin/deno test src/discovery/queries_test.ts
```

---

## D-4: Discovery orchestrator (parallel fetch per category)

**Why:** Fan out one `searchDiscovery` call per category, in parallel, with per-category timeouts and graceful degradation.

**Files:**
- `src/discovery/orchestrator.ts` (new)
- `src/discovery/orchestrator_test.ts` (new)

**Public:**
```ts
export interface DiscoveryCandidatesByCategory {
  walletNetwork: WalletNetwork;
  candidates: Partial<Record<Category, DiscoveryEntry[]>>;
  errors: Partial<Record<Category, string>>;  // per-category failures, non-fatal
}

export async function fetchCandidates(
  categories: Category[],
  walletNetwork: WalletNetwork,
  opts?: { limit?: number; maxUsdPrice?: number; client?: typeof searchDiscovery },
): Promise<DiscoveryCandidatesByCategory>;
```

**Logic:**
1. Strip `ens` from input (not handled by discovery).
2. Build queries via `queriesForCategories`.
3. `Promise.allSettled` over per-category `searchDiscovery` calls.
4. For each fulfilled result with ≥1 entry → record in `candidates`. For each empty result or rejection → record in `errors` (e.g. `"no results"` / error message).
5. Return both maps. Partial success is normal; a category with no results just means we fall back to env-var endpoints downstream.

**Acceptance criteria:**
- Single failing category does NOT fail the whole call (other categories still return).
- ENS is silently dropped from input, never appears in `candidates` or `errors`.
- `walletNetwork` is echoed in the return.
- Concurrent fan-out (verified by timing in test — if all 5 categories take 200 ms each, total wall-time < 500 ms, not > 1000 ms).
- Passes a `client` injection so tests don't hit the real CDP API.

**Test spec:**
- `fetchCandidates fans out concurrently` — inject a stub client that sleeps 100 ms; assert total wall-time < 300 ms for 5 categories.
- `fetchCandidates collects partial results` — stub returns entries for sanctions, throws for labels, returns `[]` for onchain_history. Assert `candidates.sanctions.length > 0`, `errors.labels` is a string, `errors.onchain_history === "no results"`.
- `fetchCandidates drops ens from input` — pass `["ens", "sanctions"]`, assert no calls made for ens.
- `fetchCandidates passes walletNetwork as CAIP-2 to client` — assert stub received `eip155:8453` when walletNetwork is `"base"`.

**Validation commands:**
```bash
~/.deno/bin/deno check src/discovery/orchestrator.ts src/discovery/orchestrator_test.ts
~/.deno/bin/deno lint src/discovery/orchestrator.ts src/discovery/orchestrator_test.ts
~/.deno/bin/deno test src/discovery/orchestrator_test.ts
```

---

## D-5: LLM-driven ranking & selection

**Why:** Each category may have 5–10 candidates from D-4. We need exactly one per category, picked by recency + price + description-fit. A single structured LLM call (via the existing `defaultLlm` in `src/agent/llm.ts`) does this well — small bounded input, clear judgment task.

**Files:**
- `src/discovery/rank.ts` (new)
- `src/discovery/rank_test.ts` (new)

**Public:**
```ts
export interface RankedService {
  category: Category;
  resource: string;             // URL
  description: string;
  priceUsdc: number;            // parsed from accepts[0].amount / 1_000_000
  network: string;              // CAIP-2
  payTo: string;
  scheme: "exact" | "upto";
  qualityScore: number | null;  // from extensions.bazaar.quality.l30DaysUniquePayers
  rationale: string;            // LLM's one-line justification
}

export const RankedSelectionSchema = z.object({
  selections: z.array(z.object({
    category: CategorySchema,
    resourceIndex: z.number().int().min(0),
    rationale: z.string(),
  })),
}).describe("RankedSelection");

export async function rankServices(
  candidates: DiscoveryCandidatesByCategory,
  llm: LlmClient = defaultLlm,
): Promise<RankedService[]>;
```

**Prompt design:**
- One prompt, all categories at once (cheaper than N calls).
- Pass per-category candidates as a numbered list with: resource URL, description (truncated 200 chars), price USDC, `l30DaysUniquePayers`, scheme.
- Ask LLM to return `{category, resourceIndex, rationale}` per category.
- Selection criteria stated in the prompt: prefer higher `l30DaysUniquePayers` (recency/usage), then lower price, then description-fit. Reject entries where description doesn't match the category intent.
- Use `generateStructured(RankedSelectionSchema, prompt)` — same pattern as `llmPlan` in `src/agent/plan.ts`.

**Logic:**
1. If candidates is empty (no successful fetches) → return `[]`.
2. Build prompt, call LLM.
3. Map LLM's `{category, resourceIndex}` back to the raw `DiscoveryEntry` and project to `RankedService`.
4. Skip any category the LLM omits (degraded mode: downstream falls back to env-var endpoint).

**Acceptance criteria:**
- Returns one `RankedService` per category for which a valid LLM selection exists.
- `priceUsdc` correctly parsed (`"1000"` µUSDC → `0.001`).
- LLM's `resourceIndex` is bounds-checked; out-of-range silently dropped (don't crash).
- If LLM call fails entirely → fall back to picking the candidate with highest `l30DaysUniquePayers` (or lowest price as tiebreaker). Log a warning. (Documented in code with one short comment.)
- Test uses `mockLlm` from `src/agent/llm.ts` for deterministic fixtures.

**Test spec:**
- `rankServices returns one per category` — fixture: 2 categories, mock LLM picks index 0 for each. Assert length 2.
- `rankServices parses price correctly` — candidate has `amount: "1000"`. Assert `priceUsdc === 0.001`.
- `rankServices bounds-checks LLM index` — mock LLM returns `resourceIndex: 99`. Assert that category is dropped, not crashed.
- `rankServices falls back to quality-sort on LLM failure` — mock LLM throws. Assert returned services match highest `l30DaysUniquePayers`.
- `rankServices returns empty on empty candidates` — assert `[]`.

**Validation commands:**
```bash
~/.deno/bin/deno check src/discovery/rank.ts src/discovery/rank_test.ts
~/.deno/bin/deno lint src/discovery/rank.ts src/discovery/rank_test.ts
~/.deno/bin/deno test src/discovery/rank_test.ts
```

---

## D-6: `POST /discover` route + end-to-end test

**Why:** The user explicitly wants a callable function that runs the full pipeline and an end-to-end test that proves it works against the real CDP API. A Hono route is the cleanest way to expose it for both manual `curl` testing and an integration test.

**Files:**
- `src/discovery/discover.ts` (new) — top-level `discover(address, categories): Promise<DiscoveryPlan>` function. Pure (no HTTP framework dep). Composes D-1 → D-5.
- `src/discovery/discover_test.ts` (new) — unit test with all collaborators stubbed (fast).
- `src/routes/discover.ts` (new) — Hono router exposing `POST /discover`, validating input with zod (same pattern as `src/routes/plan.ts`).
- `src/routes/discover_test.ts` (new) — **end-to-end test** that boots the Hono app and hits the route against real CDP API + real agnic balance check.
- `src/main.ts` — add `app.route("/discover", discoverRouter)`.

**`discover()` signature:**
```ts
export interface DiscoveryPlan {
  address: string;
  walletNetwork: WalletNetwork;
  services: RankedService[];
  totalEstimatedCostUsdc: number;
  unresolvedCategories: Category[];   // categories with no successful selection
  generatedAt: string;                 // ISO timestamp
}

export async function discover(
  address: string,
  categories: Category[],
): Promise<DiscoveryPlan>;
```

`totalEstimatedCostUsdc` = sum of `priceUsdc` across `services`. Frontends use this to show "we'll spend $0.0042" before the user confirms.

**Route:**
- `POST /discover`
- Body (zod-validated): `{ address: hex40, categories?: Category[] }`
- If `categories` is omitted → default to `["sanctions", "labels", "onchain_history", "web_sentiment", "contract_analysis"]` (everything except ens).
- Response: `DiscoveryPlan` as JSON.
- Errors:
  - `400` for bad input (zod).
  - `402` with `WalletUnfundedError` body when neither wallet has USDC.
  - `502` for CDP discovery upstream failures.

**Acceptance criteria:**
- `POST /discover` with `{address: "0x9dd5..."}` returns `200` and a `DiscoveryPlan` with at least one entry in `services` when run on a live env with mainnet USDC funding.
- `totalEstimatedCostUsdc` matches `services.reduce((s,x)=>s+x.priceUsdc, 0)` exactly.
- `unresolvedCategories` lists every category that had no candidates or no LLM pick.
- Without funding, returns 402 with a helpful body.
- Without `AGNIC_API_KEY`, returns 500 with a clear "missing env" message.
- `discover()` is callable as a plain function (no HTTP needed) so library consumers can use it directly.

**Test spec — unit (`discover_test.ts`):**
- `discover composes detect→queries→fetch→rank→format` — all collaborators stubbed; assert one happy-path returns expected `DiscoveryPlan`.
- `discover sums totalEstimatedCostUsdc` — stub returns 3 services at 0.001, 0.002, 0.0007. Assert total === 0.0037.
- `discover surfaces WalletUnfundedError` — stub `detectWalletNetwork` to throw. Assert error propagates.
- `discover lists unresolvedCategories` — stub returns 5 requested categories, only 3 selected. Assert other 2 in `unresolvedCategories`.

**Test spec — end-to-end (`routes/discover_test.ts`):**
- This is the **single integration test that proves the whole feature works.** Marked with `Deno.test({ name: "...", ignore: !Deno.env.get("RUN_E2E") })` so it doesn't run by default (costs nothing — only hits read-only public endpoints — but reduces flakes from upstream).
- `POST /discover end-to-end against CDP and agnic` —
  1. Boots the Hono app on a random port.
  2. POSTs `{address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2", categories: ["sanctions", "labels"]}`.
  3. Asserts response status 200.
  4. Asserts body shape matches `DiscoveryPlan` schema (zod parse).
  5. Asserts `services.length >= 1` (at least one category resolved against the real CDP catalog).
  6. Asserts every `services[].resource` starts with `https://`.
  7. Asserts `totalEstimatedCostUsdc > 0`.
  8. Asserts `walletNetwork === "base"` (we expect mainnet funded).
  9. Logs the full response for manual inspection.
- A second e2e test runs with no categories override → asserts all 5 non-ens categories are attempted.

**Manual curl smoke test** (after implementation, for the demo):
```bash
~/.deno/bin/deno task dev   # in one terminal
curl -sS -X POST http://localhost:8000/discover \
  -H "Content-Type: application/json" \
  -d '{"address":"0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2","categories":["sanctions","labels"]}' \
  | python3 -m json.tool
```
Expected: a JSON `DiscoveryPlan` with sanctions and labels each having a `resource` URL, a `priceUsdc`, and a `rationale` string.

**Validation commands:**
```bash
~/.deno/bin/deno check src/discovery/discover.ts src/discovery/discover_test.ts src/routes/discover.ts src/routes/discover_test.ts src/main.ts
~/.deno/bin/deno lint src/discovery/ src/routes/discover.ts src/routes/discover_test.ts
~/.deno/bin/deno test src/discovery/discover_test.ts                     # fast unit
RUN_E2E=1 ~/.deno/bin/deno test --allow-net --allow-env src/routes/discover_test.ts  # real e2e
```

---

## 2. Out of scope (deliberately deferred)

- **Caching.** Research recommends a 10-min TTL hybrid cache. Land it as a follow-up; the first version fetches per-request to keep the surface area small and the e2e test simple.
- **Calling the discovered services.** That's the next feature — wire `RankedService.resource` into [src/agent/budgeted_call.ts](../src/agent/budgeted_call.ts) and [src/agent/resolve.ts](../src/agent/resolve.ts).
- **Replacing `resolve.ts`'s env-var map.** Discovery should *augment* it first (env vars as fallback for unresolved categories), then replace it once we trust it. That gate-flip is its own ticket.
- **ENS via discovery.** ENS stays on the existing `viem` public-RPC path. Reconsider only if a clearly better x402 ENS provider appears.
- **`MIGRATIONS.md` / `docs/agent-log.md` updates** — handled by the CLAUDE.md "agent memory" rule at feature-completion time, not part of the plan itself.

---

## 3. Recommended ticket order

1. D-1 (network detector) — unblocks everything else
2. D-2 (discovery client) — independent, can run in parallel with D-1
3. D-3 (query map) — trivial, can land same PR as D-2
4. D-4 (orchestrator) — depends on D-1, D-2, D-3
5. D-5 (ranker) — depends on D-4's return shape
6. D-6 (`/discover` route + e2e) — depends on D-5

If shipped one-per-PR, total ~6 PRs. If batched into a single PR, all five files (`discovery/*.ts` + `routes/discover.ts` + `main.ts` mount) land together with one integration test gating the whole thing — that's the recommendation for hackathon velocity.

---

## 4. Definition of done (the whole feature)

- All six tickets' acceptance criteria green.
- `~/.deno/bin/deno task check` and `~/.deno/bin/deno task lint` pass.
- `~/.deno/bin/deno task test` passes (unit tests only).
- `RUN_E2E=1 ~/.deno/bin/deno test --allow-net --allow-env src/routes/discover_test.ts` passes against live CDP + agnic with mainnet USDC funded.
- Manual curl smoke test (§D-6) returns a sensible plan in under 5 s.
- `docs/agent-log.md` updated with a new row + `docs/features/service-discovery.md` written, per CLAUDE.md agent-memory rule.
