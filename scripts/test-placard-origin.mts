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
import { resolvePlacardOrigin, isUnprintableOrigin } from "@/lib/placards/origin";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
