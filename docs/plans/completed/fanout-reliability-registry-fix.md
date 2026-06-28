> **Status:** completed — code shipped on branch `feat/fanout-reliability-registry-fix` (migration is `0003`, not `0002` — that slot was taken by `0002_service_registry_score.sql`). Prod DB migration applies via CI on merge; the one-time backfill (`deno task backfill:shapes`) is a post-merge step against prod. See `docs/features/fanout-reliability-registry-fix.md`.
> **Slug:** `fanout-reliability-registry-fix`
> **Isolation:** create a fresh worktree + feature branch off up-to-date `main` (per CLAUDE.md parallel-agent rule).
> **Note for implementer:** Tickets are ordered by dependency (1 → 2 → 3 → 4 → 5). Ticket 1 (migration) gates Tickets 2–3. Keep `data/call_recipes.json`'s 4 sample recipes byte-identical so offline cassette replay stays green without a paid re-record.

# Fan-out reliability degradation — diagnosis & fix

## Context

After discovery was removed from the main request path, the `/verify-agent`
fan-out got faster (~15s vs ~50s) but **less reliable**: more upstream services
return bad responses (over-budget / timeout) and there are no per-category
fallbacks anymore. This document captures what the live system is actually
doing today (verified against code **and** the production Neon DB) and proposes
a fix.

---

## What the main paid path does today (verified)

1. `POST /verify-agent` → `verifyAgent()` ([src/agent/verify.ts:449](src/agent/verify.ts)) does the free pre-scan, then calls **`selectFromRegistry()`** (the registry hot path; `discover()` is preserved but unused).
2. `selectFromRegistry()` ([src/registry/select.ts:77](src/registry/select.ts)) reads `getActiveServices()` → `SELECT * FROM service_registry WHERE status = 'active' ORDER BY score DESC` ([src/registry/read.ts:34](src/registry/read.ts)). For each category it takes the top-scored row as **primary** and the rest as ranked **alternates**. Call shapes are joined from `data/call_recipes.json` by `service_id`.
3. `invokeAll()` ([src/agent/invoke_all.ts:393](src/agent/invoke_all.ts)) fans out with `Promise.all`, per-host concurrency cap 2, per-call timeout 10s (`INVOKE_TIMEOUT_MS`), gateway timeout 60s. On a primary failure it walks up to 2 alternates (`invokeWithAlternates`); a failed category is dropped → `unresolved` and the verdict is synthesized from whatever succeeded.
4. Per-call budget cap: `maxValue = service.priceUsdc` exactly ([src/agent/invoke_service.ts:126](src/agent/invoke_service.ts) → [src/clients/agnic.ts:54](src/clients/agnic.ts)). If upstream now charges more than the stored price, Agnic returns `payment_exceeds_max`, which is a **HARD error** ([src/agent/invoke_service.ts:45](src/agent/invoke_service.ts)) — no LLM fallback, no retry.

---

## Root cause (this is the whole story)

### Live DB state (Neon `super-grass-68246474`, prod)

| status | count | scores |
|--------|-------|--------|
| `active` | **0** | — |
| `probation` | 30 | all 1.0000 (default, never recomputed) |
| `blocked` | 4 | 0.286–0.357 (genuinely failed → demoted) |

- `service_observations`: **67 rows, latest today** — it is *not* empty; it is written from the hot path. (User's premise was outdated here.)
- `usage_events`: **0 rows** — there is **no writer anywhere**; it's a dormant W1.2 billing placeholder. Empty is expected.

### The two compounding bugs

**Bug A — there are zero `active` services, so selection silently bypasses the DB.**
`selectFromRegistry` only treats DB rows as the active set when `active.length > 0` ([select.ts:112](src/registry/select.ts)). With 0 active rows it falls into the **offline fallback** `else` branch ([select.ts:131](src/registry/select.ts)) that was meant only for "DB unreachable / local replay": it treats **every recipe in `data/call_recipes.json` as active@1.0**. The blocked-status guard ([select.ts:118](src/registry/select.ts)) is in the *other* branch, so **`blocked` status is completely ignored** in production.

Why 0 active: the original services decayed `active → probation → blocked` via recompute ([score.ts:81](src/registry/score.ts)). New candidates are inserted by the vetter as `probation` and can only be promoted at reliability ≥ 0.80 — but they never receive traffic (selection ignores probation), so they never earn the observations needed for promotion. **Deadlock → 0 active forever.**

**Bug B — `data/call_recipes.json` contains only 4 recipes, and all 4 are the now-`blocked` services.**

| recipe | category | resource | DB status |
|--------|----------|----------|-----------|
| 2cd85635 | sanctions | api.anchor-x402.com/v1/screen | **blocked** |
| fa57acc6 | labels | orbisapi…wallet-cex-flows-api-2b99a1 | **blocked** |
| 2ea24300 | onchain_history | orbisapi…wallet-api-5f3267/balance | **blocked** |
| 76236d8a | web_sentiment | orbisapi…crypto-news-sentiment-api | **blocked** |

So the production fan-out today resolves **each category to exactly one service — the blocked/dead one — with zero alternates** (one recipe per category in the file). That is precisely "more bad responses and no fallbacks." The 30 healthy probation candidates (orbisapi risk APIs, relaystation, mru-oracle, blockrun, etc.) are **uninvokable** because no recipes exist for them — the vetter's discovery inserts a registry row but **never snapshots a call recipe** for it.

### How this connects to the "increased cost limit" deaths (Q3)

`maxValue` is pinned to the exact stored price with **no headroom**, so any upstream price drift → `payment_exceeds_max` → hard fail. The vetter *should* absorb this (probe price, auto-bump to real×1.20 under a $0.10 ceiling, write DB **and** recipe — [src/vetter/run.ts:238](src/vetter/run.ts)), but: it runs only every 12h ([.github/workflows/vetter.yml](.github/workflows/vetter.yml)), over-ceiling services ($0.50 chain-analyzer, $0.10 solidus) are moved to probation instead of bumped, and bumps to DB rows are moot while the hot path is stuck on the 4-recipe fallback.

**Bottom line:** the cost-limit error is real but secondary. Even with perfect pricing, the hot path can currently only reach 4 blocked services. Fixing pricing alone will **not** restore reliability — Bugs A and B must be fixed.

---

## Decisions (confirmed with user)

- **Full systemic fix** (not just a hotfix).
- **Single source of truth = the DB.** Call shapes (method/params/body) move *into* `service_registry`. `data/call_recipes.json` is demoted to a **4-entry sample/seed + offline-replay fixture** and is **never** consulted in the production path.
- **No silent stale fallback.** In production the active-set always comes from the DB; if the DB read throws, the **request fails** (clear error) rather than falling back to a checked-in recipe. The recipe-as-active behavior is confined to explicit offline mode (`DATABASE_URL` unset) for the CI replay gate only.
- **Re-run discovery to snapshot shapes** → write them to the DB (not the file).
- **`maxValue` headroom buffer** for price drift (no in-path adaptive retry).
- **DB sizing is a non-issue** — call shapes measured at **89–150 bytes/row** (~120 avg); never in `WHERE`/`ORDER BY`, only in the `SELECT` projection, so indexes are untouched. At 1,000 services ≈ 120KB total. Use `jsonb` for structured fields, `text` for `method`/`body_type`, **no index**.

---

## Plan

### Ticket 1 — DB schema: store call shapes (single source of truth)
- New migration `db/migrations/0002_*.sql`: `ALTER TABLE service_registry ADD COLUMN method text, ADD COLUMN query_params jsonb, ADD COLUMN path_params jsonb, ADD COLUMN body_schema jsonb, ADD COLUMN body_type text;` — all nullable, **no index** (read-only projection data).
- Update `ServiceRegistryRow` in [src/db/types.ts](src/db/types.ts) column-for-column.
- **Acceptance:** `deno task db:migrate` applies cleanly against the Neon dev branch; `describe_table_schema` shows the new columns.
- **Validation:** `~/.deno/bin/deno check src/db/types.ts`.

### Ticket 2 — selection reads everything from the DB; dies if DB unreachable
- [src/registry/read.ts](src/registry/read.ts): `getActiveServices` → select `active` **and** `probation` (exclude `blocked`), `SELECT` the new shape columns, `ORDER BY (status='active') DESC, score DESC, created_at ASC` so active outranks probation as a fallback tier. Add a `rowToRanked()` that builds `RankedService` directly from the row's shape columns (replacing the `recipeToRanked` join).
- [src/registry/select.ts](src/registry/select.ts): branch on `dbEnabled()` ([src/db/client.ts](src/db/client.ts)):
  - **DB enabled (prod):** `active = await getActive()`. **Do not catch/swallow** — a thrown read propagates and fails the request. Build candidates from DB rows only; the recipe file is not read. Primary = top-ranked per category (active before probation), alternates = the rest.
  - **DB disabled (offline/test only):** keep the existing recipe-file-as-active@1.0 path for replay. Leave the 4 sample recipes byte-identical so cassettes stay valid (no re-record).
  - Keep the `blocked` guard as defense-in-depth.
- [src/routes/errors.ts](src/routes/errors.ts) + verify routes: map a selection/DB failure to a clear `registry_unavailable` 503 instead of an unhandled 500.
- **Acceptance:** with DB reachable + 0 active + N probation, selection yields probation candidates (primary + alternates per category); with the DB read throwing, the request returns `registry_unavailable`; with `DATABASE_URL` unset, offline replay behaves exactly as today.
- **Test spec** (`src/registry/select_test.ts`): (a) `dbEnabled` + active+probation rows via `getActive` seam → probation appears as fallback alternates, ranked below active; (b) `dbEnabled` + `getActive` throws → `selectFromRegistry` rejects (no recipe fallback); (c) `dbEnabled` + blocked row in seam → never selected; (d) `DATABASE_URL` unset → recipe-file fallback still used.
- **Validation:** `~/.deno/bin/deno check src/registry/select.ts src/registry/read.ts && ~/.deno/bin/deno test --allow-net --allow-env src/registry/select_test.ts`.

### Ticket 3 — discovery snapshots call shapes into the DB (closes the deadlock)
- Thread the discovered call shape (`DiscoveryEntry`/`RankedService.inputInfo`, the same fields [scripts/snapshot-recipes.ts](scripts/snapshot-recipes.ts) captures) through the vetter's `insertCandidate` ([src/vetter/run.ts:127](src/vetter/run.ts)) so a newly discovered candidate is written **with its shape columns** and is immediately invokable — no more "registry row with no recipe" dead candidates.
- **Backfill:** a one-time script (adapt `snapshot-recipes.ts` to `UPDATE service_registry SET method/query_params/... WHERE resource = …`) run once against the prod DB to populate shapes for the existing 30 probation rows. This is the "re-run discovery to snapshot" step, writing to the DB.
- **Acceptance:** after backfill, every non-blocked `service_registry` row has non-null shape columns; a fresh vetter discovery run inserts new candidates with shapes populated.
- **Validation:** `~/.deno/bin/deno check src/vetter/run.ts scripts/<backfill>.ts`; read-only Neon query confirms shape coverage.

### Ticket 4 — `maxValue` headroom for price drift
- [src/agent/invoke_service.ts:126](src/agent/invoke_service.ts): `maxValueUsd: priceUsdc` → `maxValueUsd: Math.min(priceUsdc * BUFFER, CEILING)` with `BUFFER` from env `INVOKE_MAXVALUE_BUFFER` (default `1.5`) and a hard `CEILING` (reuse the vetter's `0.10`). Absorbs small upstream increases without an instant `payment_exceeds_max`; the vetter reconciles the stored price on its next run.
- **Acceptance:** a service whose real price drifts up by <50% (still under ceiling) now succeeds instead of hard-failing; spend stays bounded by the ceiling.
- **Test spec** (`src/agent/invoke_service_test.ts`): asserts the `maxValue` sent to the agnic client = `min(price×buffer, ceiling)` for prices below and above the ceiling.
- **Validation:** `~/.deno/bin/deno check src/agent/invoke_service.ts && ~/.deno/bin/deno test --allow-net --allow-env src/agent/invoke_service_test.ts`.

### Ticket 5 — promotion deadlock (now self-healing)
With probation in the selection path (Ticket 2) **and** invokable (Ticket 3), probation services receive real traffic → accumulate `service_observations` → the existing recompute ([src/registry/score.ts:88](src/registry/score.ts)) promotes them to `active` at reliability ≥ 0.80. No new mechanism required — verify the loop closes after a vetter run; document it in the feature note.

---

## Verification (end-to-end)

- `~/.deno/bin/deno task test` — offline replay **must stay green without a re-record**. The 4 sample recipes are left byte-identical and the offline branch is unchanged, so the recorded HTTP traffic is identical (per CLAUDE.md cutover rule, this is a NO-record change). If replay goes red, fix the code/assertion — do not re-record.
- `~/.deno/bin/deno check` + `~/.deno/bin/deno lint` on every changed file.
- New unit tests per Tickets 2 and 4 above.
- Migration applied to the Neon dev branch; backfill run; read-only Neon MCP checks: (a) shape coverage on non-blocked rows, (b) selection now yields >1 candidate per category, (c) after a vetter run, at least some probation→active promotions.
- Update `docs/agent-log.md` + `docs/features/<slug>.md` per CLAUDE.md agent-memory rules.
