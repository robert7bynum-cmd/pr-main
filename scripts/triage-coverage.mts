/**
 * Per-category coverage and adversarial probes, against the SQL matcher.
 *
 * Same throwaway Postgres as triage-eval: migrations, then the rules through
 * lib/triage/load-rules.ts, then `match_keywords` — the function production
 * calls. Exits 1 on a wrong category, an unmarked fall-through, or a probe
 * failure; it used to exit 0 regardless.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadRules } from "../lib/triage/load-rules.ts";
import type { Category } from "../lib/triage/keywords.ts";
import { TRIAGE_FIXTURES } from "../lib/triage/fixtures.ts";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort())
  await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
console.log("rules loaded:", JSON.stringify(await loadRules(db)), "\n");

const match = async (text: string) =>
  (await db.query<{ category: string; urgency: string }>(
    `select category, urgency::text from match_keywords($1)`, [text])).rows[0] ?? null;

const CATS: Category[] = ["pace_of_play","course_maintenance","cart_issue","pro_shop",
  "f_and_b","restroom_facilities","practice_facility","safety","caddie_valet","needs_review"];

const tbl: Record<string, { fixtures: number; matched: number; wrong: number; fellThrough: number }> = {};
for (const c of CATS) tbl[c] = { fixtures: 0, matched: 0, wrong: 0, fellThrough: 0 };

let wrongCategory = 0;
const unmarked: typeof TRIAGE_FIXTURES = [];
for (const f of TRIAGE_FIXTURES) {
  const t = tbl[f.expectedCategory];
  if (!t) { console.log(`!! fixture with unknown category: ${f.expectedCategory}`); wrongCategory++; continue; }
  t.fixtures++;
  const m = await match(f.text);
  if (!m) {
    t.fellThrough++;
    // Fell through but was NOT marked as intentional.
    if (!f.note) unmarked.push(f);
  } else if (m.category === f.expectedCategory) t.matched++;
  else { t.wrong++; wrongCategory++; console.log(`!! wrong category: "${f.text}" got ${m.category} want ${f.expectedCategory}`); }
}

console.log("category               fixtures  matched  wrong  fell-through");
for (const c of CATS) {
  const t = tbl[c];
  const flag = t.fixtures === 0 ? "   << NO FIXTURES" : t.matched === 0 ? "   << NEVER MATCHES" : "";
  console.log(`${c.padEnd(22)} ${String(t.fixtures).padStart(5)} ${String(t.matched).padStart(8)} ${String(t.wrong).padStart(6)} ${String(t.fellThrough).padStart(12)}${flag}`);
}

console.log(`\nunmarked fall-throughs (coverage gaps): ${unmarked.length}`);
unmarked.forEach((f) => console.log(`  "${f.text}"  -> want ${f.expectedCategory}`));

// Adversarial probes written by hand, not from the agent's own fixtures.
const probes: [string, Category | null, string][] = [
  ["this hole is a killer", null, "figure of speech, must not be safety"],
  ["the beverage cart never came around", "f_and_b", "cart word, but F&B"],
  ["my cart is dead on 14", "cart_issue", "actual cart"],
  ["cart path is washed out", "course_maintenance", "path not cart"],
  ["someone got hit by a ball on 3", "safety", "real injury"],
  ["group ahead is playing slow", "pace_of_play", "classic"],
  ["out of paper in the mens room", "restroom_facilities", "supplies"],
  ["no towels on the ball washer", "course_maintenance", "amenity"],
  ["range balls are gone", "practice_facility", "range"],
  ["valet took forever", "caddie_valet", "valet"],
  ["bees everywhere near 9 tee", "safety", "hazard"],
  ["the greens are absolutely killing me today", null, "complaint, not safety"],
];
console.log("\nadversarial probes:");
let bad = 0;
for (const [text, want, why] of probes) {
  const m = await match(text);
  const got = m ? m.category : null;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  "${text}" -> ${got ?? "null"}${ok ? "" : ` (want ${want ?? "null"} — ${why})`}${m?.urgency === "urgent" ? "  [URGENT]" : ""}`);
}
console.log(`\nprobe failures: ${bad}/${probes.length}`);
console.log(`wrong categories: ${wrongCategory}   unmarked fall-throughs: ${unmarked.length}`);
process.exit(bad || wrongCategory || unmarked.length ? 1 : 0);
