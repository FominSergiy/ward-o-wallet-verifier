# Product pivot — free product page, self-serve keys, blog

## Context

WARD-o started as a hackathon entry. We've validated that a paid product isn't
the right near-term move; instead we make it **free and shared** (Sergiy funds
the USDC spend out of pocket while it's cheap, and revisits if usage grows). The
site changes from a single-purpose demo into a small, honest **product page**:
top-level nav, a segmented landing page, a blog, and a self-serve flow to get an
API key that unlocks the MCP server.

We also correct the public copy. The decks/README oversell:

- They claim live x402 re-discovery **every call** — but the hot path is now a
  curated DB registry (`selectFromRegistry` in `src/agent/verify.ts`).
- They claim answers "in seconds" — the **deep** tier is honestly slower (the
  in-app `/docs` "Honest scorecard" already admits the discovery latency).
- They lean on x402 as the headline — but a lot of the real signal is **free
  chain primitives** (Chainalysis oracle, ENS, label registries), and the
  **fast** tier is a free, sub-second sanctions gate with zero spend.

New voice: _"Give WARD-o a wallet address; it tells your agent whether it's safe
to pay. A free, instant sanctions screen catches the hard blocks at zero cost.
An optional deep check pulls labels, on-chain history, sentiment and ENS — some
via paid providers — and an LLM weighs them into a structured verdict. The deep
check isn't instant and costs a few cents; the fast screen is free."_ No
"seatbelt", no "in seconds", no TAM/SAM.

## Decisions (confirmed with user)

- **Support link:** Buy Me a Coffee (embed button + setup steps; username via
  config).
- **Docs:** reframe public surface; **archive** hackathon-era internal docs into
  `docs/archive/` (keep decks + history, keep the live agent-workflow files).
- **Spend cap:** **no enforcement yet** — issue keys and attribute per-key spend
  in metrics, don't block.
- **Architecture page:** condense onto landing **and** keep a reframed `/docs`
  deep-dive.

## Backend

### Schema (forward-only migrations; next number is 0004)

- `db/migrations/0004_blog_posts.sql` —
  `blog_posts(id, slug UNIQUE, title, excerpt, body_md, cover_image_url, published bool default true, published_at timestamptz default now(), created_at, updated_at)` +
  `blog_posts_published_at_idx (published_at DESC)`.
- `db/migrations/0005_service_observations_api_key.sql` —
  `ALTER TABLE service_observations ADD COLUMN IF NOT EXISTS api_key_id uuid` +
  index. (No FK — keep the fire-and-forget writer cheap.
  `usage_events`/`api_keys`/`tenants` already exist from 0001.)
- `src/db/types.ts` — add `BlogPostRow`; add `api_key_id: string | null` to
  `ServiceObservationRow`.

### API keys (activate the dormant 0001 `api_keys` + `tenants` tables)

- `src/auth/api_keys.ts`:
  - `generateApiKey()` → `{ token: "wardo_sk_<hex>", keyHash, keyPrefix }` via
    `crypto.getRandomValues` (32 bytes).
  - `sha256Hex(token)` via `crypto.subtle.digest` — keys stored hashed, never
    plaintext.
  - `issueApiKey(label?)` → insert a `tenants` row (name = label ??
    "anonymous") + an `api_keys` row; return the plaintext token **once**.
  - `lookupApiKey(token)` → hash →
    `SELECT … WHERE key_hash = $ AND revoked_at IS NULL`; bump `last_used_at`;
    return `{ id, tenant_id }` or `null`.
  - No-op DB: `issueApiKey` throws a clear "database required" error;
    `lookupApiKey` returns `null`.
- `src/routes/request_key.ts` — `createRequestKeyRouter({ issueKey })` (DI
  seam). `POST /request-key` body `{ label?: string }` →
  `{ apiKey, prefix, note }`. Errors via `mapRouteError`.

### Blog API

- `src/routes/blog.ts` — `createBlogRouter({ listPosts, getPost })` (DI).
  `GET /api/blog/posts` (published only, desc) → list of card fields;
  `GET /api/blog/posts/:slug` → full post (incl. `body_md`). No-op DB → `[]`
  / 404.

### MCP auth + attribution

- `src/observability/request_context.ts` —
  `AsyncLocalStorage<{ apiKeyId?: string }>` with `runWithApiKey(id, fn)` and
  `currentApiKeyId()`.
- `src/mcp/http.ts` — authorize if bearer equals `MCP_SHARED_SECRET` (admin)
  **or** `lookupApiKey(bearer)` resolves (user key); run
  `transport.handleRequest` inside `runWithApiKey(apiKeyId, …)`. Return
  `503 mcp_disabled` only when **neither** a shared secret **nor** a DB is
  configured. Inject `lookupApiKey` via the router factory for offline tests.
- `src/observability/observations.ts` — include `api_key_id`
  (`currentApiKeyId() ?? null`) in the `service_observations` INSERT.

### Wiring

- `src/main.ts` — mount `/request-key` and `/api/blog`.
- `web/vite.config.ts` — proxy `/request-key` and `/api` to the backend (dev
  only).
- `.env.example` — document that `MCP_SHARED_SECRET` is now optional (DB keys
  also authorize) and note keys need `DATABASE_URL`.

## Frontend (reuse `web/src/theme.css` tokens + `Code`/`docs-*` styles)

- Deps: `react-markdown`, `remark-gfm`, `rehype-highlight` (reuses existing
  `highlight.js`).
- `web/src/config.ts` — `GITHUB_URL`, `LINKEDIN_URL`, `BUYMEACOFFEE_URL`
  (placeholder username), `API_BASE`.
- Router: extend the hand-rolled `router.ts` (no new lib). `App.tsx` becomes a
  switch: `/`→`LandingPage`, `/verify`→`VerifierApp` (current UI extracted
  verbatim), `/blog`→`BlogIndex`, `/blog/:slug`→`BlogPost`, `/docs`→`DocsPage`.
- `Logo.tsx` nav → About `/`, Verifier `/verify`, Blog `/blog` (Docs link in
  footer).
- `LandingPage.tsx` — five sections per the brief, honest voice; section 3 has a
  live "Generate my key" button (`requestApiKey()`), the curl, and the MCP
  config snippet; section 5 is Buy Me a Coffee.
- `BlogIndex.tsx` / `BlogPost.tsx` + `api.ts` additions (`fetchBlogPosts`,
  `fetchBlogPost`, `requestApiKey`).
- `Footer.tsx` — add GitHub + Buy Me a Coffee alongside LinkedIn.

## Docs

- Rewrite `README.md` to the honest framing + current routes.
- Reframe `web/src/components/DocsPage.tsx` (product not hackathon; registry
  hot-path; two MCP tools + key auth; keep the honest scorecard).
- `docs/archive/`: move decks (`WARD-o*.html/.pptx`), `docs/research/`,
  `docs/real-wallet-tests/`, `docs/plans/completed/`, historical
  `docs/features/*`. Keep `docs/agent-log.md`, `docs/plans/planned/`,
  `docs/deployment.md`, `docs/assets/`. Update `CLAUDE.md` pointers that
  reference moved paths (e.g. the `src/fixtures/wallets.ts` source note).

## Acceptance criteria

- `POST /request-key` returns a `wardo_sk_…` key; its SHA-256 is stored in
  `api_keys`; the plaintext is never persisted.
- MCP `/mcp` authorizes with a freshly issued key (not just
  `MCP_SHARED_SECRET`); an unknown bearer → 401; neither secret nor DB → 503.
- A deep run initiated under a key writes `service_observations` rows whose
  `api_key_id` equals that key's id.
- `GET /api/blog/posts` returns published rows newest-first;
  `/api/blog/posts/:slug` returns one (404 if missing); both return empty/404
  with no DB (no crash).
- Site: nav switches About/Verifier/Blog; landing renders 5 sections with
  working key-gen + BMAC link; blog renders markdown (incl. images); the
  verifier at `/verify` behaves exactly as today.
- Public copy contains no "in seconds" / "seatbelt" / TAM claims; README +
  `/docs` describe the registry hot-path and two honest tiers.

## Validation commands

```bash
~/.deno/bin/deno fmt <changed .ts files>
~/.deno/bin/deno lint src/auth src/routes src/observability src/mcp src/db
~/.deno/bin/deno check src/main.ts src/mcp/http.ts src/routes/request_key.ts src/routes/blog.ts src/auth/api_keys.ts
~/.deno/bin/deno task test          # offline replay + new offline unit tests
# gated true-E2E (real Neon dev branch):
DATABASE_URL=<neon-dev> RUN_E2E=1 ~/.deno/bin/deno test --allow-net --allow-env src/routes/request_key_test.ts src/mcp/http_test.ts
cd web && npm install && npm run typecheck && npm run build
```

## Test spec (named cases)

- `src/auth/api_keys_test.ts`: `generateApiKey` returns distinct tokens with
  `wardo_sk_` prefix; `sha256Hex` is deterministic and matches the stored hash;
  `lookupApiKey` returns null on no-op DB.
- `src/routes/request_key_test.ts`: `POST /request-key` (injected `issueKey`) →
  200 + `{ apiKey }`; injected failure → mapped error.
- `src/routes/blog_test.ts`: list returns injected rows newest-first; `:slug`
  hit returns the post; miss → 404; no-op DB → `[]`.
- `src/mcp/http_test.ts`: valid injected key → request reaches the transport
  (not 401); unknown bearer → 401; no secret + no DB → 503.
- Gated E2E: mint → MCP `verify_wallet` deep under the key → assert a
  `service_observations` row carries `api_key_id`.
- `deno task test` (replay) stays green — no cassette re-record (no HTTP traffic
  shape changed).

## Notes / out of scope

- No cap enforcement (tracking only) — a later migration can add
  `api_keys.spend_cap_usd` + a pre-flight check at the MCP boundary.
- Key minting is unauthenticated/self-serve; abuse surface is deep-check spend
  (untracked-cap), acceptable while free. Light rate-limiting is a follow-up.
- Blog authoring is manual `INSERT` by Sergiy (no admin UI) per request.
