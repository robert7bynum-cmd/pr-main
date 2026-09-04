/**
 * Applies every migration, then optionally the seed, to a real Postgres.
 *
 * Each migration runs inside a transaction so a failure leaves nothing
 * half-applied. Supabase's own schema differs from the PGlite stub used in
 * local tests (real auth schema, real roles), so this is the first honest test
 * of the SQL.
 */
import { Client } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error("SUPABASE_DB_URL is not set in .env.local");
  process.exit(1);
}

const withSeed = process.argv.includes("--seed");
const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
console.log("connected\n");

// Track what has run, so re-invoking only applies new files. Without this the
// second run replays 0001 and fails on "relation already exists".
await client.query(`
  create table if not exists schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  )`);
const done = new Set(
  (await client.query<{ filename: string }>("select filename from schema_migrations")).rows.map(
    (r) => r.filename,
  ),
);

const dir = "supabase/migrations";
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (done.has(f)) {
    console.log(`  --   ${f} (already applied)`);
    continue;
  }
  const sql = readFileSync(join(dir, f), "utf8");
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into schema_migrations (filename) values ($1)", [f]);
    await client.query("commit");
    console.log(`  ok   ${f}`);
  } catch (e) {
    await client.query("rollback");
    console.error(`  FAIL ${f}\n       ${(e as Error).message}`);
    await client.end();
    process.exit(1);
  }
}

if (withSeed) {
  console.log("\nseeding…");
  try {
    await client.query(readFileSync("supabase/seed.sql", "utf8"));
    console.log("  ok   seed.sql");
  } catch (e) {
    console.error(`  FAIL seed.sql\n       ${(e as Error).message}`);
    await client.end();
    process.exit(1);
  }
}

const counts = await client.query(`
  select 'courses' t, count(*)::int n from courses
  union all select 'locations', count(*)::int from locations
  union all select 'profiles', count(*)::int from profiles
  union all select 'reports', count(*)::int from reports
  union all select 'report_events', count(*)::int from report_events
  order by 1`);
console.log("\nrow counts:");
for (const r of counts.rows) console.log(`  ${String(r.t).padEnd(15)} ${r.n}`);

await client.end();
