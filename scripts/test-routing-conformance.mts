/**
 * Conformance proof for the routing decision, ahead of Beacon Hill going live.
 *
 * The whole decision — who gets paged when a member types a sentence into a
 * placard — is `resolve_recipients` plus `route_report`. Everything above it in
 * the stack trusts those two functions completely, so a wrong answer here is
 * invisible until a club finds out from a member. Existing tests show the happy
 * path works; this file exists to show the *ladder* works: that each rung fires,
 * that it fires only when every rung above it is genuinely empty, and that no
 * combination of roster and category can produce a report that reaches nobody.
 *
 * It runs against a throwaway in-process Postgres (PGlite) built from the real
 * migrations and the real seed, so the roster it manipulates is Beacon Hill's
 * actual roster and the categories are Beacon Hill's actual routing rules.
 * Verify by running, not by reading.
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
const all = async <T>(s: string, p: unknown[] = []) => (await db.query<T>(s, p)).rows;
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`);
};

// ------------------------------------------------------------------ fixtures

const course = (await one<{ id: string }>(`select id from courses where slug='beacon-hill'`))!.id;
const loc = (await one<{ id: string }>(
  `select id from locations where course_id=$1 and hole_number = 7`, [course]))!.id;
const qr = (await one<{ id: string }>(`select id from qr_codes where location_id=$1`, [loc]))!.id;

type Person = { id: string; name: string; role: string; on_duty: boolean; active: boolean };
const staff = await all<Person>(
  `select id, full_name as name, role::text as role, on_duty, active
     from profiles where course_id=$1 order by full_name`, [course]);
const memberships = await all<{ profile_id: string; department_id: string }>(
  `select sd.profile_id, sd.department_id from staff_departments sd
     join profiles p on p.id = sd.profile_id where p.course_id=$1`, [course]);
const depts = await all<{ id: string; key: string }>(
  `select id, key from departments where course_id=$1`, [course]);
const deptId = (key: string) => depts.find(d => d.key === key)!.id;
const person = (name: string) => staff.find(p => p.name.startsWith(name))!.id;
const nameOf = (id: string) => staff.find(p => p.id === id)?.name ?? id;

// Beacon Hill's real shape, and the reason these two departments are used for
// the rung-by-rung proof: maintenance has its own supervisor (so rung 2 can
// fire), cart fleet has none (so rungs 3, 4 and 5 are reachable at all).
const MAINTENANCE = deptId("maintenance");
const CART_FLEET = deptId("cart_fleet");
const MIGUEL = person("Miguel");      // supervisor, maintenance
const TOMMY = person("Tommy");        // supervisor, pro shop + player assistance
const SARAH = person("Sarah");        // manager
const CRAIG = person("Craig");        // owner
const EFRAIN = person("Efrain");      // staff, maintenance
const JOSE = person("Jose");          // staff, maintenance
const DYLAN = person("Dylan");        // staff, cart fleet
const ASHLEY = person("Ashley");      // staff, F&B + caddie

const resetRoster = () =>
  db.query(`update profiles set active = true, on_duty = false where course_id=$1`, [course]);
const onDuty = (ids: string[]) =>
  db.query(`update profiles set on_duty = true where id = any($1::uuid[])`, [ids]);

type Resolved = { profile_id: string; reason: string };
const resolve = (dept: string | null) =>
  all<Resolved>(`select * from resolve_recipients($1,$2)`, [course, dept]);

/** What one call to the ladder decided: the single rung, and who it named. */
async function ladderAnswer(dept: string | null) {
  const rows = await resolve(dept);
  const reasons = [...new Set(rows.map(r => r.reason))];
  return {
    reason: reasons.length === 1 ? reasons[0] : `MIXED(${reasons.join("|")})`,
    ids: rows.map(r => r.profile_id).sort(),
    names: rows.map(r => nameOf(r.profile_id)).sort(),
  };
}
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const who = (ids: string[]) => ids.map(nameOf).sort().join(", ") || "(nobody)";

async function newReport(body: string, courseId = course, locId = loc, qrId: string | null = qr) {
  const r = (await one<{ id: string }>(
    `insert into reports (course_id, location_id, qr_code_id, body)
     values ($1,$2,$3,$4) returning id`, [courseId, locId, qrId, body]))!;
  await db.query(`insert into triage_queue (report_id) values ($1)`, [r.id]);
  return r.id;
}
type Routed = { department_id: string | null; recipients: number; reason: string };
const route = (id: string, cat: string) =>
  one<Routed>(`select * from route_report($1,$2,'normal','summary',0.90,'keyword')`, [id, cat]);
const notifiedFor = (id: string) =>
  all<{ profile_id: string }>(`select profile_id from notifications where report_id=$1`, [id])
    .then(rows => rows.map(r => r.profile_id).sort());

// ------------------------------------------------------- rung 1: the normal path

console.log("\n1. the department's own on-duty crew is who gets paged");
await resetRoster();
await onDuty([EFRAIN, JOSE]);
let a = await ladderAnswer(MAINTENANCE);
check("a maintenance report goes to the on-duty maintenance crew",
  a.reason === "on_duty_department", a.reason);
check("and to exactly those two people, nobody else",
  sameSet(a.ids, [EFRAIN, JOSE]), who(a.ids));
check("the department's off-duty supervisor is not woken while his crew is working",
  !a.ids.includes(MIGUEL), who(a.ids));

// A person on duty in a different department is not a maintenance answer. This
// is the check that catches a missing join predicate, which would page the whole
// club for every report.
await onDuty([DYLAN, ASHLEY]);
a = await ladderAnswer(MAINTENANCE);
check("staff on duty in other departments are not pulled in",
  sameSet(a.ids, [EFRAIN, JOSE]), who(a.ids));

// -------------------------------------------- rung 2: the department supervisor

console.log("\n2. with the crew gone, the department's own supervisor is woken");
// The club is open and someone is working — just nobody in this department.
// That is what makes rung 2 a handoff to the accountable person rather than
// the last phone still awake, which is the case rung 0 now catches.
await resetRoster();
await onDuty([ASHLEY]);                     // F&B on the clock, maintenance not
a = await ladderAnswer(MAINTENANCE);
check("an off-duty supervisor still owns his department",
  a.reason === "department_supervisor", a.reason);
check("and he is the one paged", sameSet(a.ids, [MIGUEL]), who(a.ids));

await onDuty([TOMMY, SARAH, CRAIG]);
a = await ladderAnswer(MAINTENANCE);
check("his own department beats an on-duty supervisor from elsewhere",
  a.reason === "department_supervisor" && sameSet(a.ids, [MIGUEL]),
  `${a.reason}: ${who(a.ids)}`);

await resetRoster();
await onDuty([EFRAIN]);
a = await ladderAnswer(MAINTENANCE);
check("one crew member on duty is enough to stop the ladder at rung 1",
  a.reason === "on_duty_department" && sameSet(a.ids, [EFRAIN]),
  `${a.reason}: ${who(a.ids)}`);

// Offboarding has to actually stop the pages. A deactivated supervisor who still
// answered here would mean a departed employee keeps getting a club's incidents.
await resetRoster();
await db.query(`update profiles set active = false where id = $1`, [MIGUEL]);
a = await ladderAnswer(MAINTENANCE);
check("a deactivated supervisor is skipped rather than paged",
  !a.ids.includes(MIGUEL), `${a.reason}: ${who(a.ids)}`);
await resetRoster();

// ------------------------------------ rung 3: any on-duty supervisor, any department

console.log("\n3. a department with no supervisor reaches whoever is supervising");
await resetRoster();
await onDuty([MIGUEL, TOMMY]);
a = await ladderAnswer(CART_FLEET);
check("a cart report with no cart staff on duty reaches the on-duty supervisors",
  a.reason === "any_on_duty_supervisor", a.reason);
check("both on-duty supervisors are paged, whatever department they run",
  sameSet(a.ids, [MIGUEL, TOMMY]), who(a.ids));

await onDuty([DYLAN]);
a = await ladderAnswer(CART_FLEET);
check("the cart attendant clocking in takes it back off the supervisors",
  a.reason === "on_duty_department" && sameSet(a.ids, [DYLAN]),
  `${a.reason}: ${who(a.ids)}`);

// ------------------------------------------------- rung 4: on-duty management

console.log("\n4. with no supervisor on duty, management is on the hook");
await resetRoster();
await onDuty([SARAH, CRAIG]);
a = await ladderAnswer(CART_FLEET);
check("a cart report reaches the manager and the owner", a.reason === "on_duty_management", a.reason);
check("and it is those two", sameSet(a.ids, [SARAH, CRAIG]), who(a.ids));

await onDuty([TOMMY]);
a = await ladderAnswer(CART_FLEET);
check("a supervisor clocking in takes it back off management",
  a.reason === "any_on_duty_supervisor" && sameSet(a.ids, [TOMMY]),
  `${a.reason}: ${who(a.ids)}`);

// ------------------------------------------------ rung 5: nobody is on duty

console.log("\n5. an empty course wakes all leadership rather than going quiet");
await resetRoster();
a = await ladderAnswer(CART_FLEET);
check("a 6:40am cart report with nobody on duty still reaches people",
  a.reason === "unstaffed_all_leadership", a.reason);
check("every active supervisor, manager and owner is woken",
  sameSet(a.ids, [SARAH, CRAIG, MIGUEL, TOMMY]), who(a.ids));

// Someone being clocked in is not the same as someone being able to act: an
// F&B attendant on duty cannot fix a cart, and the ladder must still escalate.
await onDuty([ASHLEY]);
a = await ladderAnswer(CART_FLEET);
check("an on-duty attendant who cannot help does not suppress the wake-up",
  a.reason === "unstaffed_all_leadership" && sameSet(a.ids, [SARAH, CRAIG, MIGUEL, TOMMY]),
  `${a.reason}: ${who(a.ids)}`);

await onDuty([CRAIG]);
a = await ladderAnswer(CART_FLEET);
check("one manager clocking in stops the whole-leadership wake-up",
  a.reason === "on_duty_management" && sameSet(a.ids, [CRAIG]),
  `${a.reason}: ${who(a.ids)}`);

console.log("\n6. one call answers with one rung, never a blend of two");
await resetRoster();
for (const [label, dept] of [["maintenance", MAINTENANCE], ["cart fleet", CART_FLEET]] as const) {
  await resetRoster();
  await onDuty([EFRAIN, TOMMY, SARAH]);
  const mixed = await ladderAnswer(dept);
  check(`the ${label} answer names a single reason`, !mixed.reason.startsWith("MIXED"), mixed.reason);
}

// ------------------------------------------------- unmapped category fallback

console.log("\n7. a category nobody configured is still somebody's problem");
await resetRoster();
await onDuty([EFRAIN, DYLAN, ASHLEY, TOMMY]);
const needsReviewDept = (await one<{ department_id: string }>(
  `select department_id from routing_rules where course_id=$1 and category='needs_review'`,
  [course]))!.department_id;
let id = await newReport("there is a swarm of bees in the ball washer on 7");
let res = await route(id, "bee_swarm");
check("an unmapped category is not dropped", (res?.recipients ?? 0) > 0, `got ${res?.recipients}`);
check("it lands on the needs_review department, not on nothing",
  res?.department_id === needsReviewDept, `${res?.department_id}`);
const stored = await one<{ category: string; department_id: string | null; status: string }>(
  `select category, department_id, status from reports where id=$1`, [id]);
check("the report is filed as needs_review so a human triages it",
  stored?.category === "needs_review", `${stored?.category}`);
check("and it carries a department, so it appears in a queue",
  stored?.department_id === needsReviewDept, `${stored?.department_id}`);
check("its status advances past new", stored?.status === "triaged", stored?.status);

// The people paged must be able to open the report. A notification for a report
// the recipient cannot see is a silent drop with extra steps.
const seer = (await notifiedFor(id))[0];
await db.query(`select set_config('test.uid', $1, false)`, [seer]);
const visible = await one<{ n: number }>(
  `select count(*)::int n from my_queue where id = $1`, [id]);
check("a paged person can actually see the report they were paged about",
  (visible?.n ?? 0) === 1, `${nameOf(seer)} sees ${visible?.n}`);
await db.query(`select set_config('test.uid', '', false)`);

// ------------------------------------------------------------- idempotency

console.log("\n8. the webhook and the sweeper delivering the same report page nobody twice");
await resetRoster();
await onDuty([EFRAIN, JOSE]);
id = await newReport("sprinkler head snapped on 7");
const first = await route(id, "course_maintenance");
const second = await route(id, "course_maintenance");
check("the first call routes it", (first?.recipients ?? 0) > 0, `${first?.recipients}`);
check("the second call reports already_triaged", second?.reason === "already_triaged", second?.reason);
check("and claims zero recipients rather than repeating the first count",
  second?.recipients === 0, `${second?.recipients}`);
check("it still reports the department the report actually sits in",
  second?.department_id === first?.department_id,
  `${second?.department_id} vs ${first?.department_id}`);
const afterTwice = await notifiedFor(id);
check("no one is notified twice", afterTwice.length === first?.recipients,
  `${afterTwice.length} notifications vs ${first?.recipients} recipients`);
check("and no person appears twice in that set",
  new Set(afterTwice).size === afterTwice.length, who(afterTwice));
const dupEvents = await one<{ triaged: number; routed: number }>(`
  select count(*) filter (where type='triaged')::int as triaged,
         count(*) filter (where type='routed')::int  as routed
    from report_events where report_id=$1`, [id]);
check("the event trail is not doubled either",
  dupEvents?.triaged === 1 && dupEvents?.routed === 1,
  `${dupEvents?.triaged} triaged / ${dupEvents?.routed} routed`);
const queued = await one<{ status: string }>(
  `select status::text from triage_queue where report_id=$1`, [id]);
check("the queue item is closed out, not left claimed forever",
  queued?.status === "done", queued?.status);

// The loop this once caused: the sweeper holds a claim, the webhook routes the
// report, the sweeper comes back to an 'already_triaged' answer. If that answer
// cannot close the item, the stale-lock reclaim re-runs it every five minutes
// for the life of the club.
const looped = await newReport("claimed by the sweeper, routed by the webhook");
const loopedFirst = await route(looped, "course_maintenance");
await db.query(`update triage_queue set status='processing', locked_at = now() - interval '10 minutes'
                 where report_id = $1`, [looped]);
const reclaimed = await all<{ report_id: string }>(`select * from claim_triage_batch(50)`);
check("a stale claim on an already-routed report is picked back up",
  reclaimed.some(r => r.report_id === looped));
const repeat = await route(looped, "course_maintenance");
check("re-running it changes nothing", repeat?.reason === "already_triaged", repeat?.reason);
await db.query(`select complete_triage($1)`, [looped]);
const settled = await one<{ status: string; locked_at: string | null }>(
  `select status::text, locked_at from triage_queue where report_id=$1`, [looped]);
check("and the worker can close it out rather than reprocessing it forever",
  settled?.status === "done" && settled?.locked_at === null,
  `${settled?.status}, locked_at ${settled?.locked_at}`);
const loopedNotes = await notifiedFor(looped);
check("the extra pass notified nobody a second time",
  loopedNotes.length === loopedFirst?.recipients,
  `${loopedNotes.length} vs ${loopedFirst?.recipients}`);

// -------------------------------------------------------------- event trail

console.log("\n9. the event trail agrees with what actually happened");
await resetRoster();
await onDuty([DYLAN]);
id = await newReport("cart 14 will not climb the hill to 8");
res = await route(id, "cart_issue");
const trail = await all<{ type: string; payload: Record<string, unknown> }>(
  `select type::text, payload from report_events where report_id=$1 order by id`, [id]);
check("a triaged event is written", trail.some(e => e.type === "triaged"),
  trail.map(e => e.type).join(","));
const routedEvent = trail.find(e => e.type === "routed");
check("a routed event is written", !!routedEvent, trail.map(e => e.type).join(","));
const actualNotes = await notifiedFor(id);
check("the recipients count in the event equals the notifications actually created",
  routedEvent?.payload.recipients === actualNotes.length,
  `event says ${routedEvent?.payload.recipients}, table has ${actualNotes.length}`);
check("the reason in the event equals the reason returned to the caller",
  routedEvent?.payload.reason === res?.reason,
  `${routedEvent?.payload.reason} vs ${res?.reason}`);
check("the department in the event equals the department on the report",
  routedEvent?.payload.department_id === res?.department_id,
  `${routedEvent?.payload.department_id} vs ${res?.department_id}`);

// An unstaffed routing has to be legible after the fact, because the GM's first
// question the next morning is "why did this reach me at 6:40am".
await resetRoster();
id = await newReport("cart dead at the first tee, 6:40am");
res = await route(id, "cart_issue");
const unstaffedEvents = await all<{ payload: Record<string, unknown> }>(
  `select payload from report_events where report_id=$1 and type='unstaffed'`, [id]);
check("an unstaffed routing records an unstaffed event", unstaffedEvents.length === 1,
  `${unstaffedEvents.length}`);
check("and the routed event still counts the leadership it woke",
  (res?.recipients ?? 0) === 4, `${res?.recipients}`);

// The contrast, recorded here deliberately rather than left for someone to
// This suite originally found the opposite of what it now asserts, and the
// difference is worth recording. Rung 2 ignored duty and short-circuited the
// rungs below it, so any department that HAS a supervisor could never reach
// the unstaffed rung: an empty club at 6:40am paged one off-duty phone and
// wrote no unstaffed event, while a cart report in the same instant woke four
// people and raised the flag. Five of ten categories behaved that way — one
// sleeping phone was the entire response capability and nothing said so.
// 20260905220000 asks the unstaffed question before the ladder instead of at
// the bottom of it.
await resetRoster();
id = await newReport("irrigation blew out on 4, nobody on the clock");
res = await route(id, "course_maintenance");
check("an empty club wakes all leadership, not one off-duty phone",
  res?.reason === "unstaffed_all_leadership" && (res?.recipients ?? 0) > 1,
  `${res?.reason} ×${res?.recipients}`);
const quietUnstaffed = await one<{ n: number }>(
  `select count(*)::int n from report_events where report_id=$1 and type='unstaffed'`, [id]);
check("and the GM is told the club was empty", (quietUnstaffed?.n ?? -1) === 1,
  `${quietUnstaffed?.n} unstaffed events`);

// The same instant, a department with no supervisor of its own. Before the fix
// these two disagreed; the whole point is that they no longer can.
const cartId = await newReport("cart dead on 12, nobody on the clock");
const cartRes = await route(cartId, "cart_issue");
check("a department without its own supervisor answers identically",
  cartRes?.reason === res?.reason && cartRes?.recipients === res?.recipients,
  `${cartRes?.reason} ×${cartRes?.recipients} vs ${res?.reason} ×${res?.recipients}`);

// ----------------------------------------------------- no cross-club leakage

console.log("\n10. a report never reaches another club's staff");
// A second club, fully staffed and entirely on duty, sitting alongside a Beacon
// Hill with nobody on duty at all. If any predicate lost its course filter, this
// is where it shows: the rival's crew would answer Beacon Hill's page.
await db.exec(`
  insert into courses (id, slug, name)
  values ('c0000000-0000-0000-0000-0000000000ff', 'rival-oaks', 'Rival Oaks');
  insert into departments (id, course_id, key, name) values
    ('d0000000-0000-0000-0000-0000000000ff', 'c0000000-0000-0000-0000-0000000000ff', 'maintenance', 'Course Maintenance'),
    ('d0000000-0000-0000-0000-0000000000fe', 'c0000000-0000-0000-0000-0000000000ff', 'management',  'Management');
  insert into auth.users (id, instance_id, email, aud, role, email_confirmed_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values
    ('e0000000-0000-0000-0000-0000000000ff','00000000-0000-0000-0000-000000000000','super@rivaloaks.test','authenticated','authenticated',now(),'','','',''),
    ('e0000000-0000-0000-0000-0000000000fe','00000000-0000-0000-0000-000000000000','gm@rivaloaks.test','authenticated','authenticated',now(),'','','','');
  insert into profiles (id, course_id, full_name, role, on_duty, active) values
    ('e0000000-0000-0000-0000-0000000000ff','c0000000-0000-0000-0000-0000000000ff','Rival Superintendent','supervisor',true,true),
    ('e0000000-0000-0000-0000-0000000000fe','c0000000-0000-0000-0000-0000000000ff','Rival GM','manager',true,true);
  insert into staff_departments (profile_id, department_id) values
    ('e0000000-0000-0000-0000-0000000000ff','d0000000-0000-0000-0000-0000000000ff'),
    ('e0000000-0000-0000-0000-0000000000fe','d0000000-0000-0000-0000-0000000000fe');
  insert into routing_rules (course_id, category, department_id) values
    ('c0000000-0000-0000-0000-0000000000ff','course_maintenance','d0000000-0000-0000-0000-0000000000ff'),
    ('c0000000-0000-0000-0000-0000000000ff','needs_review','d0000000-0000-0000-0000-0000000000fe');
  insert into locations (id, course_id, kind, hole_number, name)
  values ('a0000000-0000-0000-0000-0000000000ff','c0000000-0000-0000-0000-0000000000ff','hole',1,'Hole 1');
`);
const rival = "c0000000-0000-0000-0000-0000000000ff";
const rivalLoc = "a0000000-0000-0000-0000-0000000000ff";
const rivalIds = (await all<{ id: string }>(`select id from profiles where course_id=$1`, [rival]))
  .map(r => r.id);

// Deliberately a cart report: cart fleet has no supervisor of its own, so with
// nobody on duty this falls all the way to the last rung — the one rung that
// selects on role alone and would leak an entire second club if its course
// filter were ever dropped.
await resetRoster();
id = await newReport("cart dead on 7 and nobody is on the clock");
res = await route(id, "cart_issue");
check("with nobody on duty the last rung is the one exercised",
  res?.reason === "unstaffed_all_leadership", res?.reason);
const bhNotified = await notifiedFor(id);
check("Beacon Hill's unstaffed report reaches Beacon Hill leadership only",
  bhNotified.length > 0 && bhNotified.every(p => !rivalIds.includes(p)), who(bhNotified));

const rivalReport = await newReport("rival bunker", rival, rivalLoc, null);
const rivalRes = await route(rivalReport, "course_maintenance");
const rivalNotified = await notifiedFor(rivalReport);
check("the rival club's report reaches its own superintendent",
  sameSet(rivalNotified, ["e0000000-0000-0000-0000-0000000000ff"]), rivalNotified.join(","));
check("and reports a real routing rather than a silent zero",
  (rivalRes?.recipients ?? 0) === 1, `${rivalRes?.recipients}`);

// -------------------------------------------- coverage matrix, with an oracle

console.log("\n11. every category, every roster state");
// The expectation is computed here in TypeScript from a snapshot of the roster,
// independently of the SQL. This is a test oracle, not a second implementation
// of the rule: the ladder lives in exactly one place, and this asserts the two
// agree on all 55 cells, which is what CLAUDE.md asks for when a rule is
// restated anywhere.
type Snapshot = { id: string; role: string; on_duty: boolean; active: boolean; depts: string[] };
const snapshot = async (): Promise<Snapshot[]> => {
  const rows = await all<{ id: string; role: string; on_duty: boolean; active: boolean }>(
    `select id, role::text as role, on_duty, active from profiles where course_id=$1`, [course]);
  return rows.map(r => ({
    ...r,
    depts: memberships.filter(m => m.profile_id === r.id).map(m => m.department_id),
  }));
};
const LEADERSHIP = ["supervisor", "manager", "owner"];
function expectedLadder(people: Snapshot[], dept: string | null) {
  const active = people.filter(p => p.active);
  const inDept = (p: Snapshot) => dept !== null && p.depts.includes(dept);
  // Rung 0: nobody at the club is on duty at all. Asked before the ladder,
  // because otherwise a department that happens to have a supervisor answers
  // rung 2 and conceals the fact that the course is unstaffed.
  if (!active.some(p => p.on_duty)) {
    const all = active.filter(p => LEADERSHIP.includes(p.role)).map(p => p.id).sort();
    if (all.length) return { reason: "unstaffed_all_leadership", ids: all };
  }
  const rungs: [string, (p: Snapshot) => boolean][] = [
    ["on_duty_department", p => p.on_duty && inDept(p)],
    ["department_supervisor", p => inDept(p) && p.role === "supervisor"],
    ["any_on_duty_supervisor", p => p.on_duty && p.role === "supervisor"],
    ["on_duty_management", p => p.on_duty && (p.role === "manager" || p.role === "owner")],
    ["unstaffed_all_leadership", p => LEADERSHIP.includes(p.role)],
  ];
  for (const [reason, hit] of rungs) {
    const found = active.filter(hit).map(p => p.id).sort();
    if (found.length) return { reason, ids: found };
  }
  return { reason: "nobody", ids: [] as string[] };
}

const STATES: { label: string; short: string; apply: (dept: string) => Promise<unknown> }[] = [
  {
    label: "its own crew on duty", short: "crew on",
    apply: d => db.query(
      `update profiles set on_duty = (id in (select profile_id from staff_departments where department_id=$2))
        where course_id=$1`, [course, d]),
  },
  {
    label: "its crew off, the rest of the club on duty", short: "crew off",
    apply: d => db.query(
      `update profiles set on_duty = (id not in (select profile_id from staff_departments where department_id=$2))
        where course_id=$1`, [course, d]),
  },
  {
    label: "only supervisors from other departments on duty", short: "sup only",
    apply: d => db.query(
      `update profiles set on_duty = (role='supervisor'
          and id not in (select profile_id from staff_departments where department_id=$2))
        where course_id=$1`, [course, d]),
  },
  {
    label: "only management on duty", short: "mgmt only",
    apply: d => db.query(
      `update profiles set on_duty = (role in ('manager','owner')
          and id not in (select profile_id from staff_departments where department_id=$2))
        where course_id=$1`, [course, d]),
  },
  {
    label: "nobody on duty at all", short: "empty",
    apply: () => db.query(`update profiles set on_duty = false where course_id=$1`, [course]),
  },
];

const RUNG_CODE: Record<string, string> = {
  on_duty_department: "DEPT",
  department_supervisor: "DSUP",
  any_on_duty_supervisor: "ASUP",
  on_duty_management: "MGMT",
  unstaffed_all_leadership: "ALL",
};

const rules = await all<{ category: string; department_id: string }>(
  `select category, department_id from routing_rules where course_id=$1 order by category`, [course]);
// The unmapped category is part of the coverage claim: an AI classifier will
// invent a category eventually, and that report must still land on somebody.
const cells: { category: string; dept: string; unmapped?: boolean }[] = [
  ...rules.map(r => ({ category: r.category, dept: r.department_id })),
  { category: "(unmapped)", dept: needsReviewDept, unmapped: true },
];

const matrix: Record<string, Record<string, string>> = {};
let silent = 0, disagreed = 0;
for (const cell of cells) {
  matrix[cell.category] = {};
  for (const state of STATES) {
    await resetRoster();
    await state.apply(cell.dept);
    const expect = expectedLadder(await snapshot(), cell.dept);
    const rid = await newReport(`${cell.category} / ${state.short}`);
    const r = await route(rid, cell.unmapped ? "wild_boar_on_the_range" : cell.category);
    const got = await notifiedFor(rid);
    if ((r?.recipients ?? 0) < 1) silent++;
    if (r?.reason !== expect.reason || !sameSet(got, expect.ids)) {
      disagreed++;
      console.log(`       ${cell.category} / ${state.short}: expected ${expect.reason} ` +
        `[${who(expect.ids)}], got ${r?.reason} [${who(got)}]`);
    }
    matrix[cell.category][state.short] = `${RUNG_CODE[r?.reason ?? ""] ?? r?.reason}×${r?.recipients}`;
  }
}

const cols = STATES.map(s => s.short);
const w0 = Math.max(...cells.map(c => c.category.length)) + 2;
const cw = Math.max(...cols.map(c => c.length), 8) + 2;
console.log("\n     " + "category".padEnd(w0) + cols.map(c => c.padEnd(cw)).join(""));
for (const cell of cells)
  console.log("     " + cell.category.padEnd(w0) +
    cols.map(c => matrix[cell.category][c].padEnd(cw)).join(""));
console.log("     DEPT on-duty department · DSUP department supervisor · ASUP any on-duty " +
  "supervisor · MGMT on-duty management · ALL all leadership\n");

check(`no cell routes to nobody (${cells.length} categories × ${STATES.length} roster states)`,
  silent === 0, `${silent} cells reached nobody`);
check("the SQL ladder agrees with the expected ladder on every cell, by identity",
  disagreed === 0, `${disagreed} cells disagreed`);

// ------------------------------------------------- notification integrity

console.log("\n12. every notification points at a real, active person at the right club");
const bad = await all<{ report_id: string; profile_id: string | null; why: string }>(`
  select n.report_id, n.profile_id,
         case when n.profile_id is null then 'no profile'
              when p.id is null         then 'profile does not exist'
              when not p.active         then 'inactive profile'
              when p.course_id <> n.course_id then 'profile at another club'
              when r.course_id <> n.course_id then 'notification at another club'
         end as why
    from notifications n
    join reports r on r.id = n.report_id
    left join profiles p on p.id = n.profile_id
   where n.profile_id is null or p.id is null or not p.active
      or p.course_id <> n.course_id or r.course_id <> n.course_id`);
check("no notification points anywhere but a live person at the report's own club",
  bad.length === 0, bad.map(b => `${b.profile_id}: ${b.why}`).join("; "));

const dupes = await all<{ report_id: string; profile_id: string; n: number }>(`
  select report_id, profile_id, count(*)::int n from notifications
   group by report_id, profile_id having count(*) > 1`);
check("nobody is queued twice for the same report", dupes.length === 0,
  dupes.map(d => `${nameOf(d.profile_id)} ×${d.n}`).join(", "));

const orphanReports = await one<{ n: number }>(`
  select count(*)::int n from reports r
   where r.status <> 'new'
     and not exists (select 1 from notifications n where n.report_id = r.id)
     and r.created_at > now() - interval '1 hour'`);
check("every report routed in this run has at least one notification",
  (orphanReports?.n ?? -1) === 0, `${orphanReports?.n} routed reports reached nobody`);

const eventsMatch = await all<{ report_id: string; said: number; actual: number }>(`
  select e.report_id, (e.payload->>'recipients')::int as said,
         (select count(*)::int from notifications n where n.report_id = e.report_id) as actual
    from report_events e
   where e.type = 'routed'
     and (e.payload->>'recipients')::int
         <> (select count(*)::int from notifications n where n.report_id = e.report_id)`);
check("no routed event anywhere disagrees with its own notification rows",
  eventsMatch.length === 0,
  eventsMatch.map(e => `${e.report_id}: said ${e.said}, was ${e.actual}`).join("; "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
