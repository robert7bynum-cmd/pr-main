/**
 * Applies the migrations and seed to an in-process Postgres (PGlite) so the SQL
 * is verified without Supabase or Docker. Not a substitute for running against
 * the real project — Supabase's auth schema is stubbed here — but it catches
 * syntax errors, wrong column names, bad enum values, and constraint violations.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = await PGlite.create({ extensions: { pgcrypto } });

await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));

const dir = "supabase/migrations";
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

for (const f of files) {
  try {
    await db.exec(readFileSync(join(dir, f), "utf8"));
    console.log(`  ok   ${f}`);
  } catch (e) {
    console.log(`  FAIL ${f}\n       ${(e as Error).message}`);
    process.exit(1);
  }
}

console.log("\nseeding…");
try {
  await db.exec(readFileSync("supabase/seed.sql", "utf8"));
  console.log("  ok   seed.sql");
} catch (e) {
  console.log(`  FAIL seed.sql\n       ${(e as Error).message}`);
  process.exit(1);
}

const counts = await db.query<{ t: string; n: number }>(`
  select 'courses' t, count(*)::int n from courses
  union all select 'locations', count(*)::int from locations
  union all select 'qr_codes', count(*)::int from qr_codes
  union all select 'departments', count(*)::int from departments
  union all select 'profiles', count(*)::int from profiles
  union all select 'routing_rules', count(*)::int from routing_rules
  union all select 'reports', count(*)::int from reports
  union all select 'report_events', count(*)::int from report_events
  union all select 'triage_queue', count(*)::int from triage_queue
  order by 1
`);
console.log("\nrow counts:");
for (const r of counts.rows) console.log(`  ${r.t.padEnd(15)} ${r.n}`);
