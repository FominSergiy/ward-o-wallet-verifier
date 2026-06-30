# Deployment runbook

One-time provisioning steps + ongoing operations for backend (Deno Deploy) and frontend (Cloudflare Pages). CI is fully automated via [.github/workflows/ci.yml](../.github/workflows/ci.yml) — only the dashboard wiring below is manual.

## Topology

```
GitHub: FominSergiy/agnic-agent-wallet-verifier
│
├── PR / push to main → GitHub Actions CI (deno fmt/lint/check/test + web typecheck/build)
│
├── push to main → Deno Deploy   → https://<project>.deno.dev   (REST API + MCP at /mcp)
└── push to main → Cloudflare Pages → https://<project>.pages.dev (web UI → calls API)
```

Both platforms also build preview deployments for every PR. The Actions workflow runs in parallel; configure it as a required merge check in the repo's branch-protection settings so failing CI blocks merges.

## 1. Backend — Deno Deploy (one-time)

1. Sign in at https://dash.deno.com and click **New Project → Deploy from GitHub**.
2. Authorize the Deno Deploy GitHub app on `FominSergiy/agnic-agent-wallet-verifier`.
3. Project settings:
   - **Production branch:** `main`
   - **Entry point:** `src/main.ts`
   - **Install / build step:** leave empty (Deno fetches deps at runtime).
4. Add environment variables (Project → Settings → Environment Variables):

   | Key | Value | Notes |
   |-----|-------|-------|
   | `AGNIC_API_KEY` | `agnic_tok_…` | **Required.** From your local `.env`. |
   | `MCP_SHARED_SECRET` | `openssl rand -hex 32` output | **Required to expose `/mcp`.** Bearer token agents must send as `Authorization: Bearer <secret>`. If unset, `/mcp` returns `503 mcp_disabled`. |
   | `AI_MODEL` | e.g. `anthropic/claude-sonnet-4.6` | Optional override. |
   | `SYNTHESIS_MODEL` | e.g. `anthropic/claude-opus-4.7` | Optional override. |
   | `AGNIC_BUDGET_MIN_USD` | e.g. `0.10` | Optional pre-flight floor. |
   | `ALLOWED_ORIGIN` | `*` initially, then the Pages URL after step 2 | CORS. |

   `DENO_DEPLOYMENT_ID` is set automatically by the platform — the health store reads it to switch to in-memory mode. No action needed.

5. First deploy fires on push. Record the production URL: `https://<project>.deno.dev`.
6. Smoke:
   ```bash
   curl https://<project>.deno.dev/health
   # → {"status":"ok","db":"disabled"}   (db:"ok" once DATABASE_URL is set — see 1b)

   curl -X POST https://<project>.deno.dev/discover \
     -H 'Content-Type: application/json' \
     -d '{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","chain":"eth"}'
   ```

## 1b. Database — Neon (one-time)

Managed serverless Postgres. Chosen for its pooled endpoint, which fits Deno Deploy's many-short-lived-isolates connection model. No Docker anywhere — local dev uses a Neon dev branch.

> **`DATABASE_URL` lives in THREE distinct places — and they must NOT all be the
> same value.** The code reads a single `DATABASE_URL` ([src/db/client.ts](../src/db/client.ts))
> with no notion of "dev" vs "prod"; the *environment* picks the branch:
> 1. **Local `.env`** → the Neon **dev branch** pooled string (local only).
> 2. **GitHub `deno-deploy` *environment* secret `DATABASE_URL`** → the Neon
>    **main (prod) branch** pooled string. Consumed by the CI `migrate` job
>    ([ci.yml](../.github/workflows/ci.yml)) and the vetter cron
>    ([vetter.yml](../.github/workflows/vetter.yml)). Set it under
>    Settings → Environments → `deno-deploy` → Secrets (NOT repo-level Actions
>    secrets), e.g. `gh secret set DATABASE_URL --env deno-deploy --body '<prod-pooled>'`.
> 3. **Deno Deploy dashboard env var `DATABASE_URL`** → the same **main (prod)**
>    string. Consumed by the live API runtime.
>
> **Failure mode to avoid:** reusing the dev-branch string in (2) or (3). If you
> do, CI migrations, the vetter cron, and/or the live API all write to the *dev*
> branch and the Neon **main** branch shows zero traffic — which is exactly the
> bug this note exists to prevent. Always confirm with the `/health` check below.

1. Sign in at https://neon.tech → **Create project** (region close to the Deno Deploy region).
2. Copy the **pooled** connection string (Dashboard → Connection Details → toggle **Pooled connection**). It looks like `postgresql://USER:PASS@ep-xxxx-pooler.REGION.aws.neon.tech/DB?sslmode=require`.
3. In **Deno Deploy** → Project → Settings → Environment Variables, add `DATABASE_URL` = that pooled string.
4. Apply the schema against prod. Two paths:
   - **One-time / manual:**
     ```bash
     DATABASE_URL='<pooled-string>' deno task db:migrate
     # → applied 0001_init.sql   (re-running prints "up to date")
     ```
   - **CI (ongoing):** add the prod pooled string as the `DATABASE_URL` secret in
     the **`deno-deploy` GitHub *environment*** (Settings → Environments →
     `deno-deploy` → Secrets — *not* repo-level Actions secrets). The `migrate`
     job in `.github/workflows/ci.yml` then runs `scripts/migrate.ts` on every
     push to `main` (after backend tests pass). It's forward-only + idempotent,
     so it applies only new migrations and no-ops once current; if the secret is
     absent the job skips cleanly. This keeps prod schema in lockstep with `main`
     without manual runs.

   Then verify the deploy is actually wired to it — `curl https://<project>.deno.dev/health` should now report `{"status":"ok","db":"ok"}` (`"db":"error"` means the URL is set but unreachable; `"disabled"` means it's still unset).

   > **Note — schema only, not data.** CI migrates the schema; it does **not** run
   > `scripts/seed-registry.ts`. Seeding the curated `service_registry` from
   > `data/call_recipes.json` is a separate, deliberate step (run it once per
   > branch) so automated deploys don't clobber registry rows the future W0.10
   > vetter will manage (status flips, recomputed scores). Until the registry is
   > seeded on a given branch, `selectFromRegistry` falls back to reading
   > `data/call_recipes.json` directly at score 1.0.
5. **Local dev:** create a Neon **dev branch** (Branches → New branch off `main`), copy *its* **pooled** (`-pooler`) connection string into your local `.env` as `DATABASE_URL`, and run `deno task db:migrate` against it. We use the pooled endpoint in both prod and local so the connection path is identical everywhere; the dev branch is isolated, so local writes never touch prod.

Leaving `DATABASE_URL` unset makes the DB layer a no-op — fine for running the offline test suite, but routes that read/write Postgres will behave as if the store is empty.

## 2. Frontend — Cloudflare Pages (one-time)

1. Sign in at https://dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git**.
2. Authorize Cloudflare on `FominSergiy/agnic-agent-wallet-verifier`.
3. Build settings:
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Root directory (advanced):** `web`
   - **Build command:** `npm ci && npm run build`
   - **Build output directory:** `dist`
4. Environment variables (set for both **Production** and **Preview**):

   | Key | Value |
   |-----|-------|
   | `VITE_API_BASE_URL` | `https://<project>.deno.dev` (from step 1) |

5. Trigger first deploy. Record the production URL: `https://<project>.pages.dev`.
6. Back to **Deno Deploy** → set `ALLOWED_ORIGIN=https://<project>.pages.dev` (replace the `*` from step 1.4).
7. Smoke: open the Pages URL, submit a wallet address, confirm the verify stream renders and the network panel shows requests hitting the Deno Deploy origin with `200`s and no CORS errors.

## 3. Branch protection (one-time)

Repo Settings → **Branches → Add rule** for `main`:

- ☑︎ Require status checks to pass before merging
  - ☑︎ `Backend (Deno)` (from `ci.yml`)
  - ☑︎ `Frontend (Vite + React)` (from `ci.yml`)
- ☑︎ Require branches to be up to date before merging

## Ongoing operations

- **Day-to-day:** open a PR → both platforms post preview URLs as PR comments. Merge to `main` → both auto-deploy in ~30–60s.
- **Rollback:** Deno Deploy → Project → Deployments → click any prior deployment → **Promote to production**. Cloudflare Pages → Deployments → **Rollback**.
- **Secret rotation:** rotate `AGNIC_API_KEY` or `MCP_SHARED_SECRET` in the Deno Deploy dashboard; the next deploy picks it up. No code change. Rotating `MCP_SHARED_SECRET` invalidates all live MCP sessions — connected agents will need to re-initialize with the new bearer token.
- **Logs:** Deno Deploy → Project → Logs. Cloudflare Pages → Deployment → View build / Functions logs.
- **Post-deploy smoke (telemetry):** after a deploy, run the gated prod E2E to prove `usage_events` is written and `api_key_id` / `tenant_id` attribution lands on the MCP path. It mints a fresh key, runs one paid deep check through the live `/mcp`, then reads the prod DB to assert both rows. **Real x402 spend (~$0.01–0.05 USDC).**
  ```bash
  RUN_PROD_E2E=1 PROD_BASE_URL=https://wallet-verifier.ward-o.deno.net \
    DATABASE_URL=<prod-readonly-production-branch> \
    ~/.deno/bin/deno task smoke:prod
  ```
  Unset `RUN_PROD_E2E` → the test is skipped, so it never runs in the offline `deno task test` gate.

## 4. MCP endpoint

The MCP server (`verify_wallet` tool) ships on the same Deno Deploy project. No second deployment, no extra dashboard wiring beyond `MCP_SHARED_SECRET` in step 1.4.

- **Mount path:** `https://<project>.deno.dev/mcp` (handles POST + GET-SSE; SDK does the method routing internally).
- **Auth:** every request must carry `Authorization: Bearer <MCP_SHARED_SECRET>`. Unauthenticated → `401`. Env var unset → `503 { "error": "mcp_disabled" }`.
- **Session header:** the SDK assigns `Mcp-Session-Id` on `initialize`; the client must echo it on follow-up requests. Already in the CORS allowlist.

### Smoke test

```bash
# 1) initialize — expect HTTP 200 + Mcp-Session-Id response header
curl -i -X POST https://<project>.deno.dev/mcp \
  -H "Authorization: Bearer $MCP_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'

# 2) list tools — reuse the Mcp-Session-Id from step 1
curl -s -X POST https://<project>.deno.dev/mcp \
  -H "Authorization: Bearer $MCP_SHARED_SECRET" \
  -H "Mcp-Session-Id: <session-id-from-step-1>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
# → response includes `verify_wallet`
```

### Connect Claude Desktop / Code

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`) — add under `mcpServers`:

```json
{
  "mcpServers": {
    "ward-o-wallet-verifier": {
      "transport": "streamable-http",
      "url": "https://<project>.deno.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_SHARED_SECRET"
      }
    }
  }
}
```

Claude Code (`claude mcp add`):

```bash
claude mcp add ward-o-wallet-verifier \
  --transport http \
  --url https://<project>.deno.dev/mcp \
  --header "Authorization: Bearer YOUR_MCP_SHARED_SECRET"
```

A successful `verify_wallet` call takes ~45–90s and costs ~$0.01–0.05 USDC against `AGNIC_API_KEY`; callers should set the SDK `callTool` timeout to ≥300s.

### Known limits

- **Session storage** is in-memory per Deno Deploy isolate. Multi-replica deploys may route follow-up requests to a different isolate that doesn't know the session. Acceptable for the demo; Redis is the production fix.
- **No per-caller spend cap** beyond `AGNIC_BUDGET_MIN_USD` / per-tool `budgetCeiling`. Treat the bearer secret as a sensitive credential — anyone with it can spend your `AGNIC_API_KEY`.
