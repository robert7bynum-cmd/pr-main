/**
 * The SQL matcher is what production runs. This asserts it agrees with the
 * TypeScript rules the eval suite has always tested — the two must never
 * diverge, because lib/triage/keywords.ts is where rules are written and
 * triage_keywords is where they execute.
 */
import { Client } from "pg";
import { matchKeywords } from "../lib/triage/keywords.ts";
import { TRIAGE_FIXTURES } from "../lib/triage/fixtures.ts";

const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

let agree = 0; const diffs: string[] = [];
for (const f of TRIAGE_FIXTURES) {
  const ts = matchKeywords(f.text)?.category ?? null;
  const r = await c.query<{ category: string }>(`select category from match_keywords($1)`, [f.text]);
  const sql = r.rows[0]?.category ?? null;
  if (ts === sql) agree++;
  else diffs.push(`  "${f.text.slice(0, 54)}"  ts=${ts ?? "null"}  sql=${sql ?? "null"}`);
}
console.log(`agree: ${agree}   differ: ${diffs.length}  (of ${TRIAGE_FIXTURES.length})`);
diffs.slice(0, 10).forEach((d) => console.log(d));
await c.end();
process.exit(diffs.length ? 1 : 0);
