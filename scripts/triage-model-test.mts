import { matchKeywords } from "../lib/triage/keywords.ts";
import { TRIAGE_FIXTURES } from "../lib/triage/fixtures.ts";
import { classifyWithModel } from "../lib/triage/classify.ts";

// Only the reports the keyword pass could not resolve — the exact population
// that reaches the model in production. Testing the rest would spend money
// proving something the free pass already handles.
const fallThrough = TRIAGE_FIXTURES.filter((f) => !matchKeywords(f.text));

console.log(`model-pass population: ${fallThrough.length} of ${TRIAGE_FIXTURES.length} fixtures\n`);

let correct = 0, needsReview = 0, wrong = 0, inTok = 0, outTok = 0;
const misses: string[] = [];

for (const f of fallThrough) {
  const c = await classifyWithModel(f.text);
  inTok += c.usage?.input ?? 0;
  outTok += c.usage?.output ?? 0;

  const hit = c.category === f.expectedCategory;
  if (hit) correct++;
  else if (c.category === "needs_review") needsReview++;
  else { wrong++; misses.push(`  got ${c.category} / want ${f.expectedCategory} — "${f.text.slice(0, 70)}"`); }

  console.log(`${hit ? "ok  " : c.category === "needs_review" ? "rev " : "MISS"} ${c.category.padEnd(20)} ${c.urgency.padEnd(7)} conf ${c.confidence.toFixed(2)}  "${f.text.slice(0, 52)}"`);
}

// Haiku 4.5: $1.00 / MTok in, $5.00 / MTok out
const cost = (inTok / 1e6) * 1.0 + (outTok / 1e6) * 5.0;
console.log(`\ncorrect: ${correct}   deferred to needs_review: ${needsReview}   wrong: ${wrong}`);
if (misses.length) { console.log("\nmisroutes:"); misses.forEach((m) => console.log(m)); }
console.log(`\ntokens: ${inTok} in / ${outTok} out`);
console.log(`cost this run: $${cost.toFixed(5)}  (~$${(cost / fallThrough.length).toFixed(5)} per model-classified report)`);
