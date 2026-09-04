import { matchKeywords, type Category } from "../lib/triage/keywords.ts";
import { TRIAGE_FIXTURES } from "../lib/triage/fixtures.ts";

const CATS: Category[] = ["pace_of_play","course_maintenance","cart_issue","pro_shop",
  "f_and_b","restroom_facilities","practice_facility","safety","caddie_valet","needs_review"];

const tbl: Record<string, { fixtures: number; matched: number; fellThrough: number }> = {};
for (const c of CATS) tbl[c] = { fixtures: 0, matched: 0, fellThrough: 0 };

for (const f of TRIAGE_FIXTURES) {
  const t = tbl[f.expectedCategory];
  if (!t) { console.log(`!! fixture with unknown category: ${f.expectedCategory}`); continue; }
  t.fixtures++;
  const m = matchKeywords(f.text);
  if (!m) t.fellThrough++;
  else if (m.category === f.expectedCategory) t.matched++;
}

console.log("category               fixtures  matched  fell-through");
for (const c of CATS) {
  const t = tbl[c];
  const flag = t.fixtures === 0 ? "   << NO FIXTURES" : t.matched === 0 ? "   << NEVER MATCHES" : "";
  console.log(`${c.padEnd(22)} ${String(t.fixtures).padStart(5)} ${String(t.matched).padStart(8)} ${String(t.fellThrough).padStart(12)}${flag}`);
}

// Fixtures that fall through but were NOT marked as intentional.
const unmarked = TRIAGE_FIXTURES.filter((f) => !matchKeywords(f.text) && !f.note);
console.log(`\nunmarked fall-throughs (coverage gaps): ${unmarked.length}`);
unmarked.forEach((f) => console.log(`  "${f.text}"  -> want ${f.expectedCategory}`));

// Adversarial probes I wrote by hand, not from the agent's own fixtures.
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
  const m = matchKeywords(text);
  const got = m ? m.category : null;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  "${text}" -> ${got ?? "null"}${ok ? "" : ` (want ${want ?? "null"} — ${why})`}${m?.urgency === "urgent" ? "  [URGENT]" : ""}`);
}
console.log(`\nprobe failures: ${bad}/${probes.length}`);
