/**
 * Loads the keyword rules from their source of truth into the database.
 *
 * lib/triage/keywords.ts stays the place rules are written and reviewed; this
 * pushes them into triage_keywords so the SQL matcher — the only matcher that
 * runs in production — has them. Re-runnable.
 */
import { Client } from "pg";
import { ALL_RULES } from "../lib/triage/keywords.ts";
import { readFileSync } from "node:fs";

const src = readFileSync("lib/triage/keywords.ts", "utf8");

// The misspelling map and idiom list are plain object/array literals; pull them
// out of the source rather than duplicating them by hand.
const missBlock = src.slice(src.indexOf("const MISSPELLINGS"), src.indexOf("};", src.indexOf("const MISSPELLINGS")));
const misspellings = [...missBlock.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);

const idiomStart = src.indexOf("SAFETY_FALSE_POSITIVE_IDIOMS: string[] = [");
const idiomBlock = src.slice(idiomStart, src.indexOf("];", idiomStart));
const idioms = [...idiomBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (!idioms.length) throw new Error("no safety idioms extracted — these prevent false urgent alerts");

const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query("begin");
await c.query("delete from triage_keywords");
await c.query("delete from triage_misspellings");
await c.query("delete from triage_safety_idioms");

for (const r of ALL_RULES) {
  await c.query(
    `insert into triage_keywords (phrase, category, urgency, confidence, exclude)
     values ($1,$2,$3,$4,$5) on conflict (phrase, category) do nothing`,
    [r.phrase, r.category, r.urgency, r.confidence, r.exclude ?? []],
  );
}
for (const [wrong, right] of misspellings) {
  await c.query(`insert into triage_misspellings (wrong, right_word) values ($1,$2)
                 on conflict (wrong) do update set right_word = excluded.right_word`, [wrong, right]);
}
for (const p of idioms) {
  await c.query(`insert into triage_safety_idioms (phrase) values ($1) on conflict do nothing`, [p]);
}
await c.query("commit");

const counts = await c.query(`select
  (select count(*)::int from triage_keywords) rules,
  (select count(*)::int from triage_misspellings) misspellings,
  (select count(*)::int from triage_safety_idioms) idioms`);
console.log("loaded:", JSON.stringify(counts.rows[0]));
await c.end();
