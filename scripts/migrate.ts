// Minimal forward-only migration runner.
//
// Reads db/migrations/*.sql in lexical order and applies any not yet recorded
// in the schema_migrations bookkeeping table, each inside its own transaction.
// Idempotent: re-running applies nothing new. Requires DATABASE_URL.
//
//   DATABASE_URL=<neon-url> deno task db:migrate
//
// Versions are the leading numeric token of the filename (e.g. "0001" from
// "0001_init.sql").

import { dirname, fromFileUrl, join } from "@std/path";
import postgres from "postgres";

const MIGRATIONS_DIR = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "db",
  "migrations",
);

function versionOf(filename: string): string {
  const match = filename.match(/^(\d+)/);
  if (!match) {
    throw new Error(
      `migration filename must start with a version number: ${filename}`,
    );
  }
  return match[1];
}

async function listMigrations(): Promise<
  { version: string; file: string; path: string }[]
> {
  const entries: { version: string; file: string; path: string }[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    entries.push({
      version: versionOf(entry.name),
      file: entry.name,
      path: join(MIGRATIONS_DIR, entry.name),
    });
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  return entries;
}

export async function migrate(url: string): Promise<string[]> {
  // prepare: false — we run through Neon's pooled (-pooler) endpoint, which is
  // PgBouncer in transaction-pooling mode and incompatible with postgres.js's
  // default named prepared statements. See src/db/client.ts.
  const sql = postgres(url, { ssl: "require", max: 1, prepare: false });
  const applied: string[] = [];
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const rows = await sql<
      { version: string }[]
    >`SELECT version FROM schema_migrations`;
    const done = new Set(rows.map((r) => r.version));

    for (const m of await listMigrations()) {
      if (done.has(m.version)) continue;
      const ddl = await Deno.readTextFile(m.path);
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO schema_migrations (version) VALUES (${m.version})`;
      });
      applied.push(m.file);
      console.log(`applied ${m.file}`);
    }
  } finally {
    await sql.end();
  }
  return applied;
}

if (import.meta.main) {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    console.error("DATABASE_URL is required to run migrations");
    Deno.exit(1);
  }
  const applied = await migrate(url);
  console.log(
    applied.length === 0
      ? "no migrations to apply (up to date)"
      : `applied ${applied.length} migration(s)`,
  );
}
