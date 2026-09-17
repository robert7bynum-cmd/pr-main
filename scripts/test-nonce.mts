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
import { MEMBER_NO_NEEDED } from "../lib/queue/member-number";
import { loadRules } from "../lib/triage/load-rules.ts";

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
/**
 * A food and drink request asks for the member number at the form.
 *
 * The keyword pass runs on the words as they arrive; when it says f_and_b and
 * no number was given, the submission is refused before the nonce is touched,
 * so the member adds the number and sends the same form again. The message is
 * matched by app/actions/submit-report.ts through lib/queue/member-number.ts;
 * this holds the migration to that string.
 */
console.log("\nmember number at the form");
{
  // A placard nobody else in this file has used, so flood control stays out of it.
  const placard = (await one<{ token: string }>(
    `select token from qr_codes where active and token <> $1 order by token limit 1`, [token]))!;
  const mintFor = async () =>
    (await one<{ issue_scan_nonce: string }>(`select issue_scan_nonce($1)`, [placard.token]))!.issue_scan_nonce;
  const refusedWith = async (sql: string, p: unknown[]) => (await fails(sql, p)) ?? "";
  // The harness has no keyword rules unless a suite loads them; the intake
  // gate reads match_keywords, so without this the gate passes vacuously.
  const loaded = await loadRules(db);
  check("keyword rules are loaded", loaded.rules > 0, JSON.stringify(loaded));
  const kw = await one<{ category: string }>(`select category from match_keywords($1)`,
    ["The beverage cart hasnt come by, can we get two waters and a hot dog"]);
  check("the matcher reads that request as food and drink", kw?.category === "f_and_b", JSON.stringify(kw));
  const fresh = await mintFor();
  const refused = await refusedWith(`select submit_report($1,$2,$3)`,
    [placard.token, fresh, "The beverage cart hasnt come by, can we get two waters and a hot dog"]);
  check("a food and drink request with no member number is refused", refused.includes(MEMBER_NO_NEEDED), refused || "accepted");
  const untouched = await one<{ used_at: string | null }>(`select used_at from scan_nonces where nonce=$1`, [fresh]);
  check("and the nonce is untouched — the same scan sends again", untouched?.used_at === null, JSON.stringify(untouched));
  const blank = await refusedWith(`select submit_report($1,$2,$3,null,null,null,null,null,$4)`,
    [placard.token, fresh, "The beverage cart hasnt come by, can we get two waters and a hot dog", "  "]);
  check("a blank number is no number", blank.includes(MEMBER_NO_NEEDED), blank || "accepted");
  const filed = await one<{ submit_report: string }>(`select submit_report($1,$2,$3,null,null,null,null,null,$4)`,
    [placard.token, fresh, "The beverage cart hasnt come by, can we get two waters and a hot dog", " BH-0042 "]);
  check("with the number, the same nonce files the report", typeof filed?.submit_report === "string", JSON.stringify(filed));
  const stored = await one<{ reporter_member_no: string; source: string }>(
    `select reporter_member_no, source::text from reports where id=$1`, [filed?.submit_report]);
  check("and the number is stored, trimmed", stored?.reporter_member_no === "BH-0042", JSON.stringify(stored));
  const other = await mintFor();
  const plain = await one<{ submit_report: string }>(`select submit_report($1,$2,$3)`,
    [placard.token, other, "Sprinkler head stuck on beside the cart path"]);
  check("a maintenance report never asks for one", typeof plain?.submit_report === "string", JSON.stringify(plain));
}

/**
 * Ordering food and drink: the member's second write.
 *
 * Not a report with a number bolted on — a different form, a different RPC,
 * and a member number that is structurally required rather than inferred from
 * the words. submit_order also routes inside its own transaction, so a member
 * who orders is in the kitchen's queue before the page has finished loading.
 */
console.log("\nordering food and drink");
{
  const placard = (await one<{ token: string; course_id: string }>(
    `select token, course_id from qr_codes where active and token <> $1 order by token desc limit 1`, [token]))!;
  const mintFor = async () =>
    (await one<{ issue_scan_nonce: string }>(`select issue_scan_nonce($1)`, [placard.token]))!.issue_scan_nonce;
  const refusedWith = async (sql: string, p: unknown[]) => (await fails(sql, p)) ?? "";
  const order = (n: string, body: string, memberNo: string | null) =>
    `select submit_order($$${placard.token}$$, $$${n}$$, $$${body}$$, ${memberNo === null ? "null" : `$$${memberNo}$$`})`;

  const n1 = await mintFor();
  const noNumber = await refusedWith(order(n1, "two hot dogs and a lemonade to the 9th tee", null), []);
  check("an order without a member number is refused", noNumber.includes(MEMBER_NO_NEEDED), noNumber || "accepted");
  const blank = await refusedWith(order(n1, "two hot dogs and a lemonade to the 9th tee", "   "), []);
  check("a blank member number is no member number", blank.includes(MEMBER_NO_NEEDED), blank || "accepted");
  const untouched = await one<{ used_at: string | null }>(`select used_at from scan_nonces where nonce=$1`, [n1]);
  check("and the nonce is untouched, so the same scan sends again", untouched?.used_at === null, JSON.stringify(untouched));

  const empty = await refusedWith(order(n1, "hi", "BH-0417"), []);
  check("an order that says nothing is refused", empty.includes("Please say what you would like"), empty || "accepted");

  const placed = await one<{ submit_order: string }>(order(n1, "two hot dogs and a lemonade to the 9th tee", " BH-0417 "), []);
  const id = placed?.submit_order;
  check("with a number, the order is taken", typeof id === "string", JSON.stringify(placed));

  const row = await one<{ kind: string; category: string; urgency: string; status: string; source: string;
                          reporter_member_no: string; triage_source: string; department_id: string;
                          ai_summary: string | null; ai_confidence: string | null }>(
    `select kind, category, urgency::text as urgency, status::text as status, source::text as source,
            reporter_member_no, triage_source::text as triage_source, department_id, ai_summary, ai_confidence
       from reports where id=$1`, [id]);
  check("it is an order, not an issue", row?.kind === "order", JSON.stringify(row?.kind));
  check("categorised f_and_b without anything having to guess", row?.category === "f_and_b", String(row?.category));
  check("and the source says the member declared it", row?.triage_source === "declared", String(row?.triage_source));
  check("no model summary and no confidence, because no model ran",
    row?.ai_summary === null && row?.ai_confidence === null, JSON.stringify([row?.ai_summary, row?.ai_confidence]));
  check("a hungry fourball is not an emergency", row?.urgency === "normal", String(row?.urgency));
  check("the member number is stored, trimmed", row?.reporter_member_no === "BH-0417", String(row?.reporter_member_no));

  const fnb = (await one<{ id: string }>(`select id from departments where key='f_and_b' and course_id=$1`, [placard.course_id]))!.id;
  check("routed to Food & Beverage in the same transaction that took it",
    row?.department_id === fnb, `${row?.department_id} vs ${fnb}`);
  check("and it is already triaged, not waiting for a sweep", row?.status === "triaged", String(row?.status));

  const evs = (await db.query<{ type: string; payload: Record<string, unknown> }>(
    `select type::text as type, payload from report_events where report_id=$1 order by id`, [id])).rows;
  check("the trail reads created, triaged, routed",
    evs.map((e) => e.type).join(",") === "created,triaged,routed", evs.map((e) => e.type).join(","));
  check("and the created event says it was an order", evs[0]?.payload?.kind === "order", JSON.stringify(evs[0]?.payload));
  const paged = await one<{ n: string }>(
    `select count(*) n from notifications where report_id=$1 and status='queued'`, [id]);
  check("somebody was actually paged", Number(paged?.n) > 0, `${paged?.n}`);
  const queued = await one<{ status: string }>(`select status::text as status from triage_queue where report_id=$1`, [id]);
  check("the triage queue row is done, so the worker will not re-route it", queued?.status === "done", String(queued?.status));

  const reused = await refusedWith(order(n1, "and another lemonade", "BH-0417"), []);
  check("the nonce is single use here too", reused.includes("This form has expired"), reused || "accepted");

  // A club that has closed its kitchen.
  await db.query(`update courses set settings = jsonb_set(settings, '{ordering_enabled}', 'false') where id=$1`, [placard.course_id]);
  const n2 = await mintFor();
  const closed = await refusedWith(order(n2, "a club sandwich please", "BH-0417"), []);
  check("a club that has switched ordering off refuses the order",
    closed.includes("ordering is closed right now"), closed || "accepted");
  const stillThere = await one<{ used_at: string | null }>(`select used_at from scan_nonces where nonce=$1`, [n2]);
  check("without burning the scan", stillThere?.used_at === null, JSON.stringify(stillThere));
  await db.query(`update courses set settings = settings - 'ordering_enabled' where id=$1`, [placard.course_id]);
  const n3 = await mintFor();
  const reopened = await one<{ submit_order: string }>(order(n3, "a club sandwich please", "BH-0417"), []);
  check("switching it back on takes orders again", typeof reopened?.submit_order === "string", JSON.stringify(reopened));

  const callers = (await db.query<{ role: string }>(`
    select r.rolname as role from (values ('anon'),('authenticated'),('service_role')) r(rolname)
     where has_function_privilege(r.rolname, 'submit_order(text,text,text,text,text,text,text)', 'execute')`)).rows.map((r) => r.role);
  check("a member ordering is anonymous, like a member reporting",
    callers.join(",") === "anon,authenticated,service_role", callers.join(","));
}

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
  // Closed, because the purge takes only finished reports (20260906200000):
  // an open one still needs the details it was given.
  const fileAged = async (courseId: string, locationId: string, qrId: string | null, days: number,
                          who: { name?: string; phone?: string; email?: string }, status = 'resolved') =>
    (await one<{ id: string }>(
      `insert into reports (course_id, location_id, qr_code_id, body, reporter_name, reporter_phone, reporter_email, status, created_at)
       values ($1,$2,$3,'retention probe',$4,$5,$6,$7::report_status, now() - make_interval(days => $8)) returning id`,
      [courseId, locationId, qrId, who.name ?? null, who.phone ?? null, who.email ?? null, status, days]))!.id;
  const full = { name: "Pat Member", phone: "+15555550100", email: "pat@example.com" };
  const oldReport   = await fileAged(course, hole.location_id, hole.qr_code_id, 100, full);
  const youngReport = await fileAged(course, hole.location_id, hole.qr_code_id, 10, full);
  const phoneOnly   = await fileAged(course, hole.location_id, hole.qr_code_id, 100, { phone: "+15555550199" });
  // A member number alone is a contact detail too (20260906180000).
  const numberOnly = (await one<{ id: string }>(
    `insert into reports (course_id, location_id, qr_code_id, body, reporter_member_no, status, created_at)
     values ($1,$2,$3,'retention probe','BH-0099','resolved', now() - interval '100 days') returning id`,
    [course, hole.location_id, hole.qr_code_id]))!.id;
  // Still open and long past the period. Its details stay, because stripping
  // them would leave a food and drink order nobody can ever resolve.
  const stillOpen = (await one<{ id: string }>(
    `insert into reports (course_id, location_id, qr_code_id, body, reporter_name, reporter_member_no, status, created_at)
     values ($1,$2,$3,'retention probe, still open','Pat Member','BH-0100','scheduled', now() - interval '100 days') returning id`,
    [course, hole.location_id, hole.qr_code_id]))!.id;

  const longKeeper = (await one<{ id: string }>(
    `insert into courses (slug, name, settings) values ('long-keeper','Long Keeper GC','{"retention_days": 400}') returning id`))!.id;
  const longLoc = (await one<{ id: string }>(
    `insert into locations (course_id, kind, hole_number, name) values ($1,'hole',1,'Hole 1') returning id`, [longKeeper]))!.id;
  const keptReport = await fileAged(longKeeper, longLoc, null, 100, full);

  const dueBefore = Number((await one<{ n: string }>(`
    select count(*) n from reports r join courses c on c.id = r.course_id
     where r.created_at < now() - make_interval(days => coalesce((c.settings->>'retention_days')::int, 90))
       and r.status in ('resolved', 'verified', 'closed_no_action')
       and (r.reporter_name is not null or r.reporter_phone is not null or r.reporter_email is not null
            or r.reporter_member_no is not null)`))!.n);
  check("the three aged Beacon Hill probes are due and the other two are not", dueBefore >= 3, `${dueBefore} due`);

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
  const numberRow = await one<{ reporter_member_no: string | null }>(`select reporter_member_no from reports where id = $1`, [numberOnly]);
  const { rows: numberNotes } = await noteOf(numberOnly);
  check("a 100-day-old report's member number is gone, and the note says so",
    numberRow?.reporter_member_no === null && numberNotes.length === 1
      && JSON.stringify(numberNotes[0].payload.cleared) === JSON.stringify(["reporter_member_no"]),
    JSON.stringify({ numberRow, numberNotes }));
  check("the young report and the long-keeper's report got no note",
    (await noteOf(youngReport)).rows.length === 0 && (await noteOf(keptReport)).rows.length === 0);
  const openRow = await contact(stillOpen);
  check("a report still open past the period keeps its details — an order stripped of its number could never be resolved",
    openRow?.reporter_name === "Pat Member", JSON.stringify(openRow));
  const openNumber = await one<{ reporter_member_no: string | null }>(
    `select reporter_member_no from reports where id = $1`, [stillOpen]);
  check("including the member number", openNumber?.reporter_member_no === "BH-0100", JSON.stringify(openNumber));
  check("and it gets no retention note", (await noteOf(stillOpen)).rows.length === 0);

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
