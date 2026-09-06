/**
 * docs/api.md cannot drift from the migrations.
 *
 * The doc is generated (scripts/api-doc.mts); this regenerates it to a temp
 * path and compares byte for byte with the committed copy. A new function, a
 * changed signature, a grant added or removed — any of them makes this fail
 * until `npm run api:doc` has been run and the result committed. The mobile
 * team reads the doc; this is what makes the doc worth reading.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateApiDoc, OUTPUT } from "./api-doc.mts";

const fresh = await generateApiDoc();
const tmp = join(mkdtempSync(join(tmpdir(), "proresponse-api-doc-")), "api.md");
writeFileSync(tmp, fresh);

let committed: string | null = null;
try {
  committed = readFileSync(OUTPUT, "utf8");
} catch {
  committed = null;
}

if (committed === null) {
  console.log(`  FAIL ${OUTPUT} does not exist  -> run \`npm run api:doc\` and commit the result`);
  process.exit(1);
}

if (committed !== fresh) {
  const a = committed.split("\n");
  const b = fresh.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.log(`  FAIL ${OUTPUT} is out of date  -> run \`npm run api:doc\` and commit the result`);
  console.log(`       first difference at line ${i + 1}:`);
  console.log(`       committed: ${a[i] ?? "(end of file)"}`);
  console.log(`       generated: ${b[i] ?? "(end of file)"}`);
  console.log(`       fresh copy written to ${tmp}`);
  process.exit(1);
}

console.log(`  ok   ${OUTPUT} matches the migrations (${fresh.split("\n").length} lines)`);
process.exit(0);
