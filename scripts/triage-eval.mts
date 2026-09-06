/**
 * Keyword regression suite, run against the matcher production runs.
 *
 * Boots a throwaway Postgres, applies every migration, loads the rules from
 * lib/triage/keywords.ts through the same loader the live seed uses, and asks
 * `match_keywords` about every fixture. This used to test a TypeScript copy of
 * the matcher, which passed while the SQL that actually ran disagreed on 35 of
 * 397 inputs. It also exited 0 on failure.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadRules } from "../lib/triage/load-rules.ts";
import { TRIAGE_FIXTURES } from "../lib/triage/fixtures.ts";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort())
  await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
console.log("rules loaded:", JSON.stringify(await loadRules(db)));

const match = async (text: string) =>
  (await db.query<{ category: string; urgency: string }>(
    `select category, urgency::text from match_keywords($1)`, [text])).rows[0] ?? null;

let pass = 0, wrongCat = 0, wrongUrg = 0, nullMatch = 0;
const failures: string[] = [];

for (const f of TRIAGE_FIXTURES) {
  const m = await match(f.text);
  if (!m) {
    nullMatch++;
    if (!f.note) failures.push(`NULL   | "${f.text}" expected ${f.expectedCategory}`);
    continue;
  }
  if (m.category !== f.expectedCategory) {
    wrongCat++;
    failures.push(`CAT    | "${f.text}" got ${m.category} want ${f.expectedCategory}`);
  } else if (f.expectedUrgency && m.urgency !== f.expectedUrgency) {
    wrongUrg++;
    failures.push(`URG    | "${f.text}" got ${m.urgency} want ${f.expectedUrgency}`);
  } else pass++;
}

console.log(`fixtures: ${TRIAGE_FIXTURES.length}`);
console.log(`matched correctly: ${pass}`);
console.log(`fell through to model (null): ${nullMatch}`);
console.log(`wrong category: ${wrongCat}   wrong urgency: ${wrongUrg}`);
if (failures.length) {
  console.log(`\n--- ${failures.length} issues ---`);
  failures.forEach((f) => console.log(f));
}
process.exit(failures.length ? 1 : 0);
