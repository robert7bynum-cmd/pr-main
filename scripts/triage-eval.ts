import { matchKeywords } from "../lib/triage/keywords.ts";
import { TRIAGE_FIXTURES } from "../lib/triage/fixtures.ts";

let pass = 0, wrongCat = 0, wrongUrg = 0, nullMatch = 0;
const failures: string[] = [];

for (const f of TRIAGE_FIXTURES) {
  const m = matchKeywords(f.text);
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
