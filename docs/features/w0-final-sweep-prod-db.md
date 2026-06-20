# w0-final-sweep-prod-db

**What:** Final Workstream-0 completeness sweep plus the wiring/docs fixes to give the Neon prod (`main`) branch a real consumer instead of all DB traffic hitting the dev branch.

**Files:**
- `docs/plans/completed/W0.4`, `W0.6`, `W0.8`, `W0.9`, `W0.10-*.md` — `**Status:**` headers corrected to `completed`.
- `docs/deployment.md` — new §1b callout documenting the three `DATABASE_URL` locations (local `.env` = Neon dev branch; `deno-deploy` GitHub *environment* secret = prod; Deno Deploy dashboard env var = prod) and the dev-reuse failure mode; corrected the CI-secret instruction (environment secret, not repo-level Actions secret).
- `scripts/migrate.ts` — logs the target host (`hostOf()`, credentials never printed) before migrating.
- `scripts/vet.ts` — logs the target host (or warns when `DATABASE_URL` is unset) before vetting; wraps the run in try/finally + `closeDb()` so the cron exits instead of hanging on the open postgres.js pool.
- `.github/workflows/vetter.yml` — invoke bare `deno` (on PATH from `setup-deno`) instead of the nonexistent `~/.deno/bin/deno`, which had been failing the job with exit 127.
- `docs/agent-log.md` — log row.

**Config:** No new env vars. The fix is purely about *which value* `DATABASE_URL` holds per environment. The code (`src/db/client.ts`) reads one `DATABASE_URL` with no dev/prod notion — the environment selects the Neon branch.

**Root cause documented:** One connection string (the dev-branch pooled endpoint) was reused across local `.env`, the `deno-deploy` GitHub environment secret (CI `migrate` job + vetter cron), and the Deno Deploy dashboard — so the Neon `main` branch had no consumer.

**Verified against prod (2026-06-20):** after the user set the `deno-deploy`
environment `DATABASE_URL` + `AGNIC_API_KEY` secrets, a manual `workflow_dispatch`
of the vetter wrote to the prod Neon `main` branch (3 price bumps). Surfaced and
fixed the two cron bugs above; `closeDb()` clean-exit verified locally
(getDb → query → closeDb exits in ~2s; previously hung).

**Notes / follow-ups (manual, could not be automated here):**
- `gh secret set DATABASE_URL --env deno-deploy --body '<prod-pooled>'` — blocked: the local `gh` token returns 403 (no env-secret write). Set via the GitHub UI or a token with `secrets:write`.
- `DATABASE_URL='<prod-pooled>' deno task db:migrate` then `… deno run … scripts/seed-registry.ts` — blocked by the auto-mode classifier (write against prod infra needs explicit human confirmation). Run locally.
- Set `DATABASE_URL` in the Deno Deploy dashboard to the prod string — no CLI access.
- Verify with `curl https://<project>.deno.dev/health` → `{"status":"ok","db":"ok"}` and confirm the Neon **main** branch shows activity.
- Prod pooled endpoint (provided by user): `ep-lively-hall-ai8u2hqa-pooler.c-4.us-east-1.aws.neon.tech/neondb`. Dev (local only): `ep-orange-mud-ai2kft5f-pooler…`.
