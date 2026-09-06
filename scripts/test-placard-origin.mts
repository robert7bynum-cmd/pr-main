/**
 * What address ends up inside a printed QR code.
 *
 * This is the only output of the system that becomes a physical object. A wrong
 * URL here is not a bug you patch and redeploy — it is somebody walking eighteen
 * holes with a screwdriver. The page used to build codes from the request's own
 * origin, so opening it on a laptop produced a full sheet pointing at
 * localhost:3000, with only a paragraph of warning above it.
 *
 * Pure functions, no database: this is the decision, isolated.
 */
import { readFileSync } from "node:fs";
import {
  resolvePlacardOrigin, isUnprintableOrigin,
  UNPRINTABLE_HOST_PATTERN, UNPRINTABLE_PREVIEW_PATTERN,
} from "@/lib/placards/origin";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

console.log("the club's own address wins");
{
  const r = resolvePlacardOrigin({ public_url: "https://reports.beaconhill.com" }, "http://localhost:3000");
  check("a configured address beats the machine rendering the page",
    r.origin === "https://reports.beaconhill.com" && r.source === "configured", JSON.stringify(r));
}
{
  const r = resolvePlacardOrigin({ public_url: "https://reports.beaconhill.com/" }, "http://localhost:3000");
  check("a trailing slash does not become a double slash in the code",
    r.origin === "https://reports.beaconhill.com", r.origin);
}
{
  const r = resolvePlacardOrigin({ public_url: "   " }, "https://real.example.com");
  check("whitespace is not an address", r.source !== "configured", JSON.stringify(r));
}
{
  const r = resolvePlacardOrigin(null, "https://real.example.com");
  check("with nothing configured it falls back rather than failing",
    r.origin === "https://real.example.com" && r.source === "request", JSON.stringify(r));
}

console.log("\naddresses that must never reach a sign");
for (const bad of [
  "http://localhost:3000",
  "https://localhost",
  "http://127.0.0.1:3000",
  "http://0.0.0.0:8080",
  "https://pr-main-git-main-robert7bynum-2589s-projects.vercel.app",
  "https://pr-main-git-some-branch-scope.vercel.app",
]) {
  check(`refuses ${bad}`, isUnprintableOrigin(bad));
}

console.log("\naddresses that are fine");
for (const good of [
  "https://pr-main-dun.vercel.app",
  "https://reports.beaconhill.com",
  "https://beaconhillgolfva.com",
]) {
  check(`allows ${good}`, !isUnprintableOrigin(good));
}

// The specific regression: a manager opening the page on their laptop.
console.log("\nthe failure this exists for");
{
  const r = resolvePlacardOrigin(null, "http://localhost:3000");
  check("an unconfigured club rendered on a laptop is caught, not printed",
    isUnprintableOrigin(r.origin), `${r.origin} would have been printed`);
}

// The same rule runs in the database: update_course_settings refuses to store
// one of these addresses, so the placard page's refusal is a backstop and not
// the only control. Two copies of one rule drift, so the migration carries the
// two exported patterns verbatim, and this reads the file and checks they are
// still there byte for byte — the way test-delivery-gate lifts the cron gate's
// predicate out of its migration. Rewriting either side alone fails here.
console.log("\nthe database refuses the same addresses, from the same two patterns");
{
  const MIGRATION = "supabase/migrations/20260906130000_club_settings.sql";
  let sql = "";
  try { sql = readFileSync(MIGRATION, "utf8"); } catch { /* reported by the first check */ }
  check("the migration that refuses these addresses exists", sql.length > 0, `${MIGRATION} missing`);
  check("the migration carries UNPRINTABLE_HOST_PATTERN verbatim",
    sql.includes(`'${UNPRINTABLE_HOST_PATTERN}'`), `${UNPRINTABLE_HOST_PATTERN} not in ${MIGRATION}`);
  check("and UNPRINTABLE_PREVIEW_PATTERN verbatim",
    sql.includes(`'${UNPRINTABLE_PREVIEW_PATTERN}'`), `${UNPRINTABLE_PREVIEW_PATTERN} not in ${MIGRATION}`);
  check("inside update_course_settings, not somewhere else",
    sql.indexOf("function update_course_settings") < sql.indexOf(`'${UNPRINTABLE_HOST_PATTERN}'`)
      && sql.indexOf(`'${UNPRINTABLE_HOST_PATTERN}'`) < sql.indexOf("function upsert_location"));
  // The TS regex is built from the exported string, so this proves the string
  // itself — not a copy — is what isUnprintableOrigin runs. Matched with the
  // scheme stripped, which is how both sides apply it.
  check("the exported host pattern is what the TS check runs",
    new RegExp(UNPRINTABLE_HOST_PATTERN, "i").test("localhost:3000")
      && new RegExp(UNPRINTABLE_HOST_PATTERN, "i").test("[::1]")
      && !new RegExp(UNPRINTABLE_HOST_PATTERN, "i").test("beaconhillgolfva.com")
      && !new RegExp(UNPRINTABLE_HOST_PATTERN, "i").test("localhost.beaconhill.com"));
  check("the exported preview pattern is what the TS check runs",
    new RegExp(UNPRINTABLE_PREVIEW_PATTERN, "i").test("https://pr-main-git-main-scope.vercel.app")
      && !new RegExp(UNPRINTABLE_PREVIEW_PATTERN, "i").test("https://pr-main-dun.vercel.app"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
