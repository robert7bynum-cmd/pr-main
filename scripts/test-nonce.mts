/**
 * The member submission path, including the failure that lost a real report.
 *
 * A nonce is single-use and expires after two hours, so a phone that slept with
 * the form open arrives holding a dead one. Before this suite, that silently
 * discarded everything the member had typed. These tests pin both halves of the
 * fix: the exact message submit_report raises (app code matches on its text),
 * and that a fresh nonce is always obtainable so the retry can succeed.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
for (const f of readdirSync("supabase/migrations").filter(f => f.endsWith(".sql")).sort())
  await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
await db.exec(readFileSync("supabase/seed.sql", "utf8"));

const one = async <T>(s: string, p: unknown[] = []) => (await db.query<T>(s, p)).rows[0];
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };
const fails = async (s: string, p: unknown[] = []) => {
  try { await db.query(s, p); return null; } catch (e) { return (e as Error).message; }
};

const token = (await one<{ token: string }>(`select token from qr_codes where active limit 1`))!.token;
const mint = async () =>
  (await one<{ issue_scan_nonce: string }>(`select issue_scan_nonce($1)`, [token]))!.issue_scan_nonce;
const submit = (n: string, body = "Sprinkler head is stuck open on the fairway") =>
  db.query(`select submit_report($1,$2,$3)`, [token, n, body]);
const reportCount = async () =>
  Number((await one<{ n: string }>(`select count(*) n from reports`))!.n);

console.log("nonce lifecycle");
const n1 = await mint();
check("a scan mints a nonce", typeof n1 === "string" && n1.length > 20, String(n1));

const before = await reportCount();
await submit(n1);
check("a fresh nonce files a report", (await reportCount()) === before + 1);

const reused = await fails(`select submit_report($1,$2,$3)`, [token, n1, "Second try on the same scan"]);
check("a consumed nonce is refused", reused !== null, "reuse was accepted");

// The app matches on this text to decide whether to re-mint and retry. If the
// wording in the migration changes without this test changing, recovery
// silently stops working and reports start disappearing again.
check(
  "expiry message is the exact string submit-report.ts matches",
  Boolean(reused?.includes("This form has expired")),
  reused ?? "no error raised",
);

console.log("\nstaleness recovery");
const n2 = await mint();
await db.query(`update scan_nonces set issued_at = now() - interval '3 hours' where nonce = $1`, [n2]);
const stale = await fails(`select submit_report($1,$2,$3)`, [token, n2, "Filed from a phone that slept"]);
check("a nonce older than two hours is refused", stale !== null);
check(
  "an aged-out nonce raises the same recoverable message",
  Boolean(stale?.includes("This form has expired")),
  stale ?? "no error raised",
);

// This is the retry the server action performs. It must clear the same
// rate limiter and active-placard check, then succeed.
const n3 = await mint();
const afterMint = await reportCount();
await submit(n3, "Filed from a phone that slept");
check("re-minting recovers the submission", (await reportCount()) === afterMint + 1);

console.log("\nflood control still holds");
const floodToken = (await one<{ token: string }>(
  `select token from qr_codes where active and token <> $1 limit 1`, [token]))!.token;
let minted = 0, limitHit: string | null = null;
for (let i = 0; i < 25; i++) {
  const e = await fails(`select issue_scan_nonce($1)`, [floodToken]);
  if (e) { limitHit = e; break; }
  minted++;
}
check("a placard stops minting after 20 scans in five minutes", minted === 20, `minted ${minted}`);
check("and says so", Boolean(limitHit?.includes("Too many scans")), limitHit ?? "no limit reached");

// The re-mint on submit runs the limiter too — recovery must not be a bypass.
const bypass = await fails(`select issue_scan_nonce($1)`, [floodToken]);
check("retry cannot mint past the limit either", bypass !== null, "limiter was bypassed");

console.log("\nplacard validity");
const dead = await fails(`select issue_scan_nonce($1)`, ["bh-not-a-real-placard"]);
check("an unknown placard mints nothing", Boolean(dead?.includes("not active")), dead ?? "accepted");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
