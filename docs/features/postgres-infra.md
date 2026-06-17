# postgres-infra (W0.1)

**What:** Adds the Postgres data layer — host (Neon), driver/client, initial schema, and a migration runner — that the rest of Workstream 0/1/2 builds on.

**Files:**
- `db/migrations/0001_init.sql` — initial schema: `tenants`, `api_keys`, `usage_events`, `service_registry`, `service_observations`, `service_health_durable`, plus a `schema_migrations` bookkeeping table.
- `scripts/migrate.ts` — forward-only migration runner (`deno task db:migrate`); applies any `db/migrations/*.sql` not yet in `schema_migrations`, each in its own transaction.
- `src/db/client.ts` — `getDb()` singleton over `npm:postgres`; no-op when `DATABASE_URL` is unset. Also `dbEnabled()`, `closeDb()`.
- `src/db/types.ts` — hand-written row interfaces, column-for-column with the SQL.
- `src/db/client_test.ts` — no-op-when-unset test (always runs) + `DATABASE_URL`-gated round-trip and migration-idempotency tests.
- `deno.json` — `postgres` import + `db:migrate` task.
- `.env.example`, `CLAUDE.md` (Database subsection), `docs/deployment.md` (Neon provisioning) — config + conventions.

**Config:**
- `DATABASE_URL` (optional) — single Postgres connection string. Prod = Neon **pooled** endpoint; local = Neon **dev branch**. Unset = no-op DB layer (keeps `deno task test` offline-safe). No Docker, no `SUPABASE_SERVICE_KEY`.
- New dep: `npm:postgres@^3` (postgres.js).

**Notes:**
- **Host decision:** Neon over Supabase/self-hosted — lightest path, pooled endpoint suits Deno Deploy's serverless connection model, and the schema is plain portable Postgres so host lock-in is near-zero. Conventions are locked in `CLAUDE.md` to avoid re-litigation.
- **Forward-compat:** `tenants.stripe_customer_id` (W1.3), `service_observations.severity_contribution` (W2.1) and `outcome_label` (W4) are nullable and dormant until those workstreams land. `service_health_durable` mirrors the `ServiceHealth` interface in `src/discovery/health_store.ts` so W0.3 can lift the JSON store into Postgres.
- **Driver swap path:** if Deno Deploy connection limits bite, replace the postgres.js client inside `getDb()` with `@neondatabase/serverless` (HTTP) — callers never touch the driver, so the change stays local to `src/db/client.ts`.
- **numeric columns** come back as strings from postgres.js (typed `string | null`); convert at the call site.
- **Gap:** nothing reads/writes these tables yet — that's W0.2/W0.3/W0.8/W1.1/W1.2. This ticket is infra only.
