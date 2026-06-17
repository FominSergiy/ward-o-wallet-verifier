# health-db-probe

**What:** `GET /health` now probes Postgres connectivity and returns `{ status: "ok", db: "ok" | "disabled" | "error" }`, making the prod `DATABASE_URL` wiring verifiable with a single curl.

**Files:**
- `src/main.ts` — added `dbHealth()` helper (uses `dbEnabled()` + `getDb()` from `src/db/client.ts`); `/health` handler is now async and includes the `db` field. Also exports `app` and moved `Deno.serve` behind an `import.meta.main` guard so the app can be imported in tests without starting a server.
- `src/main_test.ts` — new. Offline case asserts `db: "disabled"` (always runs); `DATABASE_URL`-gated case asserts `db: "ok"` against a live database.
- `docs/deployment.md` — smoke steps updated to the new `/health` shape; §1b step 4 now tells you to curl `/health` and expect `db:"ok"` after setting prod `DATABASE_URL`.

**Config:** none new. Reuses the existing `DATABASE_URL` / no-op-when-unset contract.

**Notes:**
- `db` semantics: `"disabled"` = `DATABASE_URL` unset (no-op client, expected offline/in CI); `"ok"` = `SELECT 1` round-trips; `"error"` = URL set but unreachable.
- The endpoint still returns HTTP 200 even when `db` is `"error"` — `/health` is a liveness probe for the HTTP process, and DB reachability is reported in the body rather than failing the whole check. Revisit if a stricter readiness probe is needed later.
- Follow-up from the W0.1 provisioning work ([postgres-infra](postgres-infra.md)); the remaining open item is setting the prod `DATABASE_URL` in the Deno Deploy dashboard (an operational step, no code).
