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

/**
 * The per-placard limit on submission itself. The nonce rewrite dropped it,
 * and the re-mint above means a nonce is never the scarce thing — the twenty
 * scans per five minutes were. Five reports per placard per two minutes is
 * back (20260906100000), checked before the nonce is consumed so a refusal
 * does not also cost the member their scan.
 */
console.log("\nflood control on submission");
{
  const failsWith = async (s: string, p: unknown[] = []) => {
    try { await db.query(s, p); return null; }
    catch (e) { return { message: (e as Error).message, code: (e as { code?: string }).code }; }
  };
  const placard = (await one<{ id: string; token: string }>(
    `select id, token from qr_codes where active and token not in ($1, $2) limit 1`, [token, floodToken]))!;
  // Whatever the seed filed here recently must not count against this test.
  await db.query(
    `update reports set created_at = created_at - interval '1 day'
      where qr_code_id = $1 and created_at > now() - interval '2 minutes'`, [placard.id]);

  const nonces: string[] = [];
  for (let i = 0; i < 6; i++)
    nonces.push((await one<{ issue_scan_nonce: string }>(`select issue_scan_nonce($1)`, [placard.token]))!.issue_scan_nonce);

  let filed = 0;
  for (let i = 0; i < 5; i++) {
    const e = await failsWith(`select submit_report($1,$2,$3)`, [placard.token, nonces[i], `Report ${i + 1} from one bench`]);
    if (!e) filed++;
  }
  check("five reports in two minutes from one placard are accepted", filed === 5, `${filed} filed`);

  const sixth = await failsWith(`select submit_report($1,$2,$3)`, [placard.token, nonces[5], "The sixth in two minutes"]);
  check("the sixth is refused", sixth !== null, "accepted");
  check("with the flood-control message",
    Boolean(sixth?.message.includes("Too many reports from this location just now.")), sixth?.message ?? "");
  check("and errcode 53400, as the scan limiter uses", sixth?.code === "53400", String(sixth?.code));
  check("it is not the stale-nonce message, so the app will not re-mint and retry",
    !sixth?.message.includes("This form has expired"), sixth?.message ?? "");

  const kept = await one<{ used_at: string | null }>(`select used_at from scan_nonces where nonce = $1`, [nonces[5]]);
  check("the refused submission did not consume its nonce", kept !== undefined && kept.used_at === null, JSON.stringify(kept));

  // Time passes: the window empties. Backdated rather than slept.
  await db.query(
    `update reports set created_at = now() - interval '3 minutes'
      where qr_code_id = $1 and created_at > now() - interval '2 minutes'`, [placard.id]);
  const n = await reportCount();
  const retry = await failsWith(`select submit_report($1,$2,$3)`, [placard.token, nonces[5], "The sixth, two minutes later"]);
  check("once the window has passed the same nonce files the report",
    retry === null && (await reportCount()) === n + 1, retry?.message ?? `count ${await reportCount()} vs ${n + 1}`);
}

/**
 * scan_nonces grew without bound: 149 rows for 13 reports on the live database,
 * and system_alerts had the same shape and no retention either. purge_expired()
 * (20260906110000, replacing purge_scan_nonces) deletes nonces older than a day
 * and alerts resolved more than thirty days ago, returns both counts, and runs
 * from the escalate sweep. PGlite has no pg_cron, so the schedule is asserted
 * on the migration text, the way test-delivery-gate does for the triage gate.
 */
console.log("\nretention");
{
  await db.query(`update scan_nonces set issued_at = now() - interval '2 days' where nonce = $1`, [n2]);
  const total = Number((await one<{ n: string }>(`select count(*) n from scan_nonces`))!.n);
  const old = Number((await one<{ n: string }>(
    `select count(*) n from scan_nonces where issued_at < now() - interval '1 day'`))!.n);
  check("a backdated nonce is what the purge will see", old >= 1, `${old} old row(s)`);

  // Three alerts: one cleared long ago (goes), one cleared yesterday (stays),
  // one still open (stays — an open alert is still telling somebody something).
  const course = (await one<{ id: string }>(`select id from courses limit 1`))!.id;
  await db.query(
    `insert into system_alerts (course_id, issue, severity, detail, resolved_at) values
       ($1, 'retention: cleared long ago', 'warning', 'purge test', now() - interval '40 days'),
       ($1, 'retention: cleared yesterday', 'warning', 'purge test', now() - interval '1 day'),
       ($1, 'retention: still open',        'warning', 'purge test', null)`, [course]);
  const alertsBefore = Number((await one<{ n: string }>(`select count(*) n from system_alerts`))!.n);

  // Contact details (20260906170000). Four reports with a name, phone and
  // email: one 100 days old at Beacon Hill (default 90 — goes), one 10 days
  // old (stays), one 100 days old at a club that keeps details for 400 days
  // (stays), and one 100 days old with only a phone (goes; the note names only
  // the phone). Whatever the seed left with details older than 90 days is
  // counted too, so the expected total is measured, not assumed.
  const hole = (await one<{ location_id: string; qr_code_id: string }>(
    `select location_id, id qr_code_id from qr_codes where active limit 1`))!;
  const fileAged = async (courseId: string, locationId: string, qrId: string | null, days: number,
                          who: { name?: string; phone?: string; email?: string }) =>
    (await one<{ id: string }>(
      `insert into reports (course_id, location_id, qr_code_id, body, reporter_name, reporter_phone, reporter_email, created_at)
       values ($1,$2,$3,'retention probe',$4,$5,$6, now() - make_interval(days => $7)) returning id`,
      [courseId, locationId, qrId, who.name ?? null, who.phone ?? null, who.email ?? null, days]))!.id;
  const full = { name: "Pat Member", phone: "+15555550100", email: "pat@example.com" };
  const oldReport   = await fileAged(course, hole.location_id, hole.qr_code_id, 100, full);
  const youngReport = await fileAged(course, hole.location_id, hole.qr_code_id, 10, full);
  const phoneOnly   = await fileAged(course, hole.location_id, hole.qr_code_id, 100, { phone: "+15555550199" });

  const longKeeper = (await one<{ id: string }>(
    `insert into courses (slug, name, settings) values ('long-keeper','Long Keeper GC','{"retention_days": 400}') returning id`))!.id;
  const longLoc = (await one<{ id: string }>(
    `insert into locations (course_id, kind, hole_number, name) values ($1,'hole',1,'Hole 1') returning id`, [longKeeper]))!.id;
  const keptReport = await fileAged(longKeeper, longLoc, null, 100, full);

  const dueBefore = Number((await one<{ n: string }>(`
    select count(*) n from reports r join courses c on c.id = r.course_id
     where r.created_at < now() - make_interval(days => coalesce((c.settings->>'retention_days')::int, 90))
       and (r.reporter_name is not null or r.reporter_phone is not null or r.reporter_email is not null)`))!.n);
  check("the two aged Beacon Hill probes are due and the other two are not", dueBefore >= 2, `${dueBefore} due`);

  const purged = (await one<{ nonces: number; alerts: number; contacts: number }>(`select * from purge_expired()`))!;
  check("purge_expired() returns how many nonces it deleted", purged.nonces === old, `returned ${purged.nonces}, expected ${old}`);
  check("and how many alerts", purged.alerts === 1, `returned ${purged.alerts}, expected 1`);
  check("and how many reports lost their contact details", purged.contacts === dueBefore, `returned ${purged.contacts}, expected ${dueBefore}`);

  const contact = (id: string) => one<{ reporter_name: string | null; reporter_phone: string | null; reporter_email: string | null; body: string }>(
    `select reporter_name, reporter_phone, reporter_email, body from reports where id = $1`, [id]);
  const anon = await contact(oldReport);
  check("a 100-day-old report has no name, phone or email",
    anon?.reporter_name === null && anon?.reporter_phone === null && anon?.reporter_email === null, JSON.stringify(anon));
  check("but the report itself is still there", anon?.body === "retention probe");
  const young = await contact(youngReport);
  check("a 10-day-old report keeps all three",
    young?.reporter_name === full.name && young?.reporter_phone === full.phone && young?.reporter_email === full.email, JSON.stringify(young));
  const kept = await contact(keptReport);
  check("a 100-day-old report at a club keeping details for 400 days keeps them",
    kept?.reporter_name === full.name && kept?.reporter_phone === full.phone && kept?.reporter_email === full.email, JSON.stringify(kept));

  const noteOf = (id: string) => db.query<{ actor_id: string | null; payload: { retention?: boolean; cleared?: string[] } }>(
    `select actor_id, payload from report_events where report_id = $1 and type = 'note'`, [id]);
  const { rows: oldNotes } = await noteOf(oldReport);
  check("exactly one note event records the anonymisation", oldNotes.length === 1, `${oldNotes.length} note(s)`);
  check("with retention true and the three fields named, and no actor",
    oldNotes[0]?.actor_id === null && oldNotes[0]?.payload.retention === true
      && JSON.stringify([...(oldNotes[0]?.payload.cleared ?? [])].sort()) === JSON.stringify(["reporter_email", "reporter_name", "reporter_phone"]),
    JSON.stringify(oldNotes[0]));
  const { rows: phoneNotes } = await noteOf(phoneOnly);
  check("a report that only had a phone says only the phone was cleared",
    phoneNotes.length === 1 && JSON.stringify(phoneNotes[0].payload.cleared) === JSON.stringify(["reporter_phone"]), JSON.stringify(phoneNotes));
  check("the young report and the long-keeper's report got no note",
    (await noteOf(youngReport)).rows.length === 0 && (await noteOf(keptReport)).rows.length === 0);

  const again = (await one<{ contacts: number }>(`select contacts from purge_expired()`))!;
  check("running it again clears nothing more, and says zero", again.contacts === 0, `returned ${again.contacts}`);
  check("and writes no second note",
    (await noteOf(oldReport)).rows.length === 1, `${(await noteOf(oldReport)).rows.length} note(s)`);
  const gone = await one<{ nonce: string }>(`select nonce from scan_nonces where nonce = $1`, [n2]);
  check("the backdated nonce is gone", gone === undefined);
  const remaining = Number((await one<{ n: string }>(`select count(*) n from scan_nonces`))!.n);
  check("and nothing younger than a day went with it", remaining === total - old, `${total} -> ${remaining}`);

  const { rows: alertsLeft } = await db.query<{ issue: string }>(
    `select issue from system_alerts where issue like 'retention:%' order by issue`);
  check("the alert resolved 40 days ago is gone",
    !alertsLeft.some((a) => a.issue === "retention: cleared long ago"), alertsLeft.map((a) => a.issue).join(", "));
  check("the alert resolved yesterday stays",
    alertsLeft.some((a) => a.issue === "retention: cleared yesterday"), alertsLeft.map((a) => a.issue).join(", "));
  check("the open alert stays",
    alertsLeft.some((a) => a.issue === "retention: still open"), alertsLeft.map((a) => a.issue).join(", "));
  const alertsAfter = Number((await one<{ n: string }>(`select count(*) n from system_alerts`))!.n);
  check("exactly one alert row went", alertsAfter === alertsBefore - 1, `${alertsBefore} -> ${alertsAfter}`);

  const { rows: callers } = await db.query<{ role: string }>(`
    select r.rolname as role from (values ('anon'),('authenticated'),('service_role')) r(rolname)
     where has_function_privilege(r.rolname, 'purge_expired()', 'execute')`);
  check("only the service role may call it",
    callers.length === 1 && callers[0].role === "service_role", callers.map((c) => c.role).join(", "));
  const oldFn = await one<{ n: string }>(`select count(*) n from pg_proc where proname = 'purge_scan_nonces'`);
  check("purge_scan_nonces() no longer exists", Number(oldFn?.n) === 0, `${oldFn?.n} definition(s) still present`);

  const MIGRATION = "supabase/migrations/20260906110000_data_owns_the_bypass.sql";
  const sql = readFileSync(MIGRATION, "utf8");
  const job = /cron\.schedule\('proresponse-escalate',\s*'\* \* \* \* \*',\s*\$job\$([\s\S]*?)\$job\$\)/.exec(sql)?.[1] ?? "";
  check("the escalate sweep is rescheduled in the migration", job.length > 0, "no cron.schedule('proresponse-escalate') body found");
  check("its body still runs escalate_reports()", /select escalate_reports\(\);/.test(job), job);
  check("and still writes the sweep heartbeat", /select record_heartbeat\('sweep',/.test(job), job);
  check("and now runs purge_expired()", /select purge_expired\(\);/.test(job), job);
  check("and no longer calls purge_scan_nonces()", !/purge_scan_nonces/.test(job), job);
  // The migration claims the other two statements are byte-for-byte what
  // 20260906100000 scheduled. Hold it to that.
  const prior = /cron\.schedule\('proresponse-escalate',\s*'\* \* \* \* \*',\s*\$job\$([\s\S]*?)\$job\$\)/
    .exec(readFileSync("supabase/migrations/20260906100000_finish_table_posture.sql", "utf8"))?.[1] ?? "";
  check("the rest of the job body is unchanged from 20260906100000",
    prior.replace("select purge_scan_nonces();", "select purge_expired();") === job, job);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
