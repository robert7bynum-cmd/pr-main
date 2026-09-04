// Re-tests only the two cases that failed, not the whole set. Verifying a fix
// should not cost the same as the original run.
import { classifyWithModel } from "../lib/triage/classify.ts";
const cases = [
  ["my back is killing me after that tee shot on 8", "needs_review"],
  ["starter sent us off 8 minutes late and now we are rushing", "caddie_valet"],
  ["someone collapsed on the 4th green", "safety"],
];
let inTok = 0, outTok = 0;
for (const [text, want] of cases) {
  const c = await classifyWithModel(text);
  inTok += c.usage?.input ?? 0; outTok += c.usage?.output ?? 0;
  console.log(`${c.category === want ? "ok  " : "MISS"} ${c.category.padEnd(16)} ${c.urgency.padEnd(7)} conf ${c.confidence.toFixed(2)}  "${text.slice(0,50)}"`);
}
console.log(`\ncost: $${((inTok/1e6)*1 + (outTok/1e6)*5).toFixed(5)}`);
