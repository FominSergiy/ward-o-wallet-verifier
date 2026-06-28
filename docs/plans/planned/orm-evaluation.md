# Plan (deferred): Evaluate an ORM / typed query builder for the DB layer

> Status: **planned / not started.** Spun out of the `centralize-status-enums`
> work (PR #75 follow-up). The user asked: "is there a better way to improve on
> string literals — perhaps introduce an ORM?" Short answer recorded here so it
> can be actioned independently. No code from this plan has landed.

## Context

The `success` vs `ok` bug (PR #75) and its fix (`centralize-status-enums`) both
stem from one root cause: **inline SQL is not type-checked against the schema.**
Status literals, column names, and value strings in `sql\`...\`` template
strings are opaque to the compiler. We closed the *status-value* slice with
`as const` unions + interpolated constants, but the broader seam remains:
column-name typos, wrong-type bindings, and result-shape mismatches in raw
queries are still only caught at runtime (or against prod).

The question is whether a query builder or ORM would prevent the whole class.

## Recommendation (summary)

**Adopt a typed query builder (Kysely), not a full ORM (Prisma/Drizzle ORM
layer), and only after a scoped spike on the registry read path.** Reasoning:

- The pain is *type-checked SQL*, not *object/relational mapping*. We have ~5
  tables, no relation graph, and access already funnels through `getDb()` with
  hand-written row types. A query builder buys compile-time column/value/result
  typing while keeping SQL-shaped code; a full ORM adds an entity layer we don't
  need.
- **Deno + Neon + `npm:postgres` fit.** Kysely runs on Deno and can sit on top
  of the existing postgres.js connection via a dialect, so `getDb()` stays the
  single connection owner (DB conventions in CLAUDE.md). Prisma's engine/codegen
  story under Deno is awkward; Drizzle works but pulls in its own schema-DSL.
- **Migration philosophy clash.** CLAUDE.md mandates forward-only plain-SQL
  migrations in `db/migrations/*.sql` as the source of truth, applied by
  `scripts/migrate.ts`. ORMs want to own schema + migrations. Any tool adopted
  must **derive its types from the existing SQL** (or a generated snapshot), not
  replace the migration workflow — otherwise we trade the literal-drift seam for
  a schema-definition-vs-migration drift seam.
- **Offline-safe invariant.** `DATABASE_URL` unset must stay a no-op client
  (`src/db/client.ts`) so `deno task test` is offline. Whatever is adopted must
  preserve that and not require a live DB to type-check or build.

## Options considered

| Option | Type-checks SQL? | Deno fit | Owns migrations? | Verdict |
|--------|------------------|----------|------------------|---------|
| Status quo + `as const` unions (done) | values only | native | no | shipped; partial |
| **Kysely (query builder)** | columns + values + results | good (dialect over postgres.js) | no (schema interface hand- or codegen-kept) | **recommended spike** |
| Drizzle ORM | yes | ok | wants to | heavier; second schema DSL |
| Prisma | yes | poor under Deno | yes | not recommended here |

## Proposed spike (if greenlit)

Scope to **one read path** to measure ergonomics before any broad migration:

1. Add Kysely with a postgres.js-backed dialect, constructed inside
   `src/db/client.ts` so `getDb()` stays the only connection owner. No-op when
   `DATABASE_URL` is unset.
2. Define a `Database` interface for `service_registry` + `service_observations`
   **derived from `src/db/types.ts`** (reuse the existing row types and the new
   `ServiceStatus`/`ObservationStatus` unions — do not re-declare).
3. Port `getActiveServices` (`src/registry/read.ts`) and `defaultFetchMetrics`
   (`src/registry/score.ts`) to Kysely as a proof. Leave everything else on raw
   `sql\`...\``.
4. Compare: does a deliberately-wrong column name / status value now fail
   `deno check`? Measure added build time, bundle, and readability.

### Acceptance criteria
- A query referencing a non-existent column or a non-`ServiceStatus` value
  **fails `deno check`** (demonstrated with a throwaway broken query in the PR
  description, not committed).
- `getActiveServices` and `defaultFetchMetrics` return byte-identical results to
  the raw-SQL versions (replay suite unchanged).
- `DATABASE_URL` unset still yields a no-op path; `deno task test` stays offline
  and green; replay 9/9 with **no cassette re-record** (logic-only).
- `getDb()` remains the sole connection constructor; no new driver instantiated
  elsewhere.

### Validation commands
```bash
~/.deno/bin/deno check src/db/client.ts src/registry/read.ts src/registry/score.ts
~/.deno/bin/deno lint src/db/ src/registry/
deno task test            # offline unit + replay 9/9
DATABASE_URL=<neon-dev> deno task test:e2e   # optional: live read path parity
```

### Test spec (named cases that must exist)
- `kysely client — no-op when DATABASE_URL unset` (mirrors the postgres.js no-op
  test): a select resolves empty with no socket.
- `getActiveServices (kysely) — excludes blocked, active outranks probation`
  (parity with the existing `read_test.ts` cases a–d).
- `defaultFetchMetrics (kysely) — counts ObservationStatus.OK as success over the
  30-day window` (guards the exact keystone the literal-drift bug hit).
- A compile-time negative: a `// @ts-expect-error` query binding a bad column /
  bad status value, proving the type layer rejects it.

## Decision gate

Greenlight the spike only if the team wants compile-time SQL safety broadly. If
the appetite is just "don't let status drift again," the shipped
`centralize-status-enums` change already covers it and this can stay deferred
indefinitely. Recommend revisiting if the schema grows past ~10 tables or starts
needing joins.
