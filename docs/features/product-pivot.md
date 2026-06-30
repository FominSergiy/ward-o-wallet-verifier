# product-pivot

**What:** Turns the hackathon demo into a free product site — top-level nav
(About / Verifier / Blog), an honest segmented landing page, a DB-backed
markdown blog, and a self-serve API-key flow that unlocks the MCP server, with
per-key usage attribution in the metrics table.

**Files:**

- DB: `db/migrations/0004_blog_posts.sql`,
  `db/migrations/0005_service_observations_api_key.sql`; row types in
  `src/db/types.ts` (`BlogPostRow`, `api_key_id` on `ServiceObservationRow`);
  `src/db/blog.ts` (read access).
- Keys: `src/auth/api_keys.ts`
  (`newToken`/`sha256Hex`/`issueApiKey`/`lookupApiKey`);
  `src/routes/request_key.ts` (`POST /request-key`).
- Blog API: `src/routes/blog.ts` (`GET /api/blog/posts`, `/posts/:slug`).
- MCP auth + attribution: `src/mcp/http.ts` (`authorizeMcp` — admin secret OR DB
  key; wraps handling in `runWithApiKey`);
  `src/observability/request_context.ts` (AsyncLocalStorage);
  `src/observability/observations.ts` (writes `api_key_id`).
- Web-UI attribution: `src/routes/key_attribution.ts` (`resolveApiKeyId`)
  wrapping `verifyAgent` in
  `src/routes/{verify_agent,verify_agent_stream,invoke}.ts`.
- Wiring: `src/main.ts` (mounts `/request-key`, `/api/blog`);
  `web/vite.config.ts` (dev proxy for `/request-key`, `/api`); `.env.example`.
- Smoke: `scripts/mcp_smoke.ts` + `deno task mcp:smoke`.
- Frontend: `web/src/App.tsx` (router switch),
  `web/src/components/{LandingPage,BlogIndex,BlogPost,VerifierApp,CodeBlock}.tsx`,
  updated `Logo.tsx`/`Footer.tsx`/`DocsPage.tsx`, `web/src/config.ts`,
  `web/src/api.ts`, `web/src/theme.css`.
- Tests: `src/auth/api_keys_test.ts`, `src/routes/{request_key,blog}_test.ts`,
  `src/mcp/http_test.ts`.
- Docs: rewrote `README.md`; reframed `DocsPage.tsx`; archived
  decks/research/real-wallet-tests to `docs/archive/`.

**Config:**

- `DATABASE_URL` (Neon) — now required for the self-serve keys + blog (no-op DB
  → keys 503, blog empty/404). Migrations `0004`/`0005` must be applied.
- `MCP_SHARED_SECRET` — now **optional**; the `/mcp` bearer also accepts any
  issued key. `503 mcp_disabled` only when neither a secret nor a DB is
  configured.
- `VITE_WARDO_WEB_KEY` (frontend build env) — optional `web-ui` attribution key
  the UI sends as a Bearer; not a secret. Provision via `POST /request-key`
  once, set in Cloudflare Pages.
- Frontend deps added: `react-markdown`, `remark-gfm`, `rehype-highlight`.
- `web/src/config.ts`: `BUYMEACOFFEE_URL` (placeholder handle — set the real
  one), `GITHUB_URL`, `LINKEDIN_URL`.

**Notes / gotchas / follow-ups:**

- **Honest copy:** dropped "in seconds" / "seatbelt" / TAM framing. The hot path
  selects from a curated registry (`selectFromRegistry`), not live x402 every
  call; the deep tier is genuinely slower; the fast tier is the free, instant
  one.
- **Keys are attribution + revocation handles, not spend gates** — anyone can
  self-serve a key (no cap), and the embedded `web-ui` key is readable in the
  bundle. Spend is bounded by the existing pre-flight budget guard. A per-key
  cap (`api_keys.spend_cap_usd`) + rate-limiting are deferred.
- **Attribution via AsyncLocalStorage** flows the key id into
  `service_observations` without threading it through the pipeline. Fast tier
  writes no observations (it short-circuits before any paid call), so
  attribution shows up only on deep runs.
- **Neon has only the `production` branch** — there is no dev branch, and
  `.env`'s `DATABASE_URL` points at prod. Migrations `0004`/`0005` are
  additive + idempotent but still need a deliberate prod apply
  (`deno task db:migrate`). Blog rows are authored by hand (no admin UI).
- **Post-deploy MCP e2e:** `WARDO_API_URL=<api> deno task mcp:smoke` (free)
  proves the token→MCP path; `--deep` + a Neon query on
  `service_observations.api_key_id` proves attribution.
- Web bundle is ~540 kB (highlight.js + react-markdown) — code-splitting the
  blog renderer is a future optimization.
