/** Staff action transitions, against throwaway Postgres. */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort())
  await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
await db.exec(readFileSync("supabase/seed.sql", "utf8"));

const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
/**
 * Act as a specific staff member. These suites used to call the action RPCs
 * with no session at all and whatever actor id they fancied — which is exactly
 * the hole the database now closes: the actor must be the caller. Setting a
 * session is not test scaffolding, it is the test finally exercising the guard.
 */
const act = async (uid: string) => {
  await db.query(`select set_config('test.uid', $1, false)`, [uid]);
};

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

const course = (await one<{ id: string }>(`select id from courses limit 1`))!.id;
const loc = (await one<{ id: string }>(`select id from locations where hole_number=7`))!.id;
const [alice, bob] = (await db.query<{ id: string; full_name: string }>(
  `select id, full_name from profiles where account_kind='individual' order by full_name limit 2`)).rows;

const mk = async () => (await one<{ id: string }>(
  `insert into reports (course_id, location_id, body, status, department_id, category)
   values ($1,$2,'test report','triaged',
     (select id from departments where key='maintenance' and course_id=$1),'course_maintenance')
   returning id`, [course, loc]))!.id;

console.log("\n1. acknowledge claims the report");
let id = await mk();
await act(alice.id);
let ack = await one<{ ok: boolean; claimed_by_name: string }>(`select * from acknowledge_report($1,$2)`, [id, alice.id]);
check("claim succeeds", ack?.ok === true);
check("records the owner", ack?.claimed_by_name === alice.full_name, ack?.claimed_by_name);

console.log("\n2. a second person cannot silently steal it");
await act(bob.id);
ack = await one(`select * from acknowledge_report($1,$2)`, [id, bob.id]);
check("second claim refused", ack?.ok === false);
check("names who already has it", ack?.claimed_by_name === alice.full_name, ack?.claimed_by_name);
const still = await one<{ claimed_by: string }>(`select claimed_by from reports where id=$1`, [id]);
check("owner unchanged", still?.claimed_by === alice.id);

console.log("\n3. resolve keeps the internal note away from the member");
await act(alice.id);
await db.query(`select resolve_report($1,$2,$3,$4)`,
  [id, alice.id, "nothing actually broken, member had the wrong hole",
   "We checked and everything is in good order — thank you for reporting it."]);
const r = await one<{ status: string; resolution_note: string; member_message: string; member_notified_at: string }>(
  `select status, resolution_note, member_message, member_notified_at from reports where id=$1`, [id]);
check("status resolved", r?.status === "resolved");
check("internal note stored", r?.resolution_note?.includes("wrong hole") === true);
check("member message differs from internal note", r?.member_message !== r?.resolution_note);
check("member notification timestamped", !!r?.member_notified_at);
const ev = await db.query<{ type: string }>(`select type from report_events where report_id=$1 order by id`, [id]);
check("event trail records resolve + member_notified",
  ev.rows.some(e => e.type === "resolved") && ev.rows.some(e => e.type === "member_notified"),
  ev.rows.map(e => e.type).join(","));

console.log("\n4. resolving without a member message notifies nobody");
id = await mk();
await act(alice.id);
await db.query(`select resolve_report($1,$2,$3)`, [id, alice.id, "swapped the valve"]);
const r2 = await one<{ member_message: string; member_notified_at: string }>(
  `select member_message, member_notified_at from reports where id=$1`, [id]);
check("no member message", r2?.member_message === null);
check("no notification timestamp", r2?.member_notified_at === null);

console.log("\n5. schedule-for-later is a real state, not a fake resolve");
id = await mk();
await act(alice.id);
await db.query(`select schedule_report($1,$2,$3,$4)`, [id, alice.id, "2026-09-12", "part on order"]);
const s = await one<{ status: string; scheduled_for: string; resolved_at: string }>(
  `select status, scheduled_for, resolved_at from reports where id=$1`, [id]);
check("status scheduled", s?.status === "scheduled");
check("not counted as resolved", s?.resolved_at === null);

console.log("\n6. re-route moves department and frees the claim");
id = await mk();
await act(alice.id);
await db.query(`select acknowledge_report($1,$2)`, [id, alice.id]);
const cart = (await one<{ id: string }>(`select id from departments where key='cart_fleet'`))!.id;
const before = (await one<{ n: number }>(`select count(*)::int n from notifications where report_id=$1`, [id]))!.n;
await act(alice.id);
await db.query(`select reroute_report($1,$2,$3)`, [id, alice.id, cart]);
const rr = await one<{ department_id: string; claimed_by: string }>(
  `select department_id, claimed_by from reports where id=$1`, [id]);
check("department changed", rr?.department_id === cart);
check("claim released for the new team", rr?.claimed_by === null);
const after = (await one<{ n: number }>(`select count(*)::int n from notifications where report_id=$1`, [id]))!.n;
check("new team is notified", after > before, `${before} -> ${after}`);
const re = await one<{ n: number }>(`select count(*)::int n from report_events where report_id=$1 and type='reassigned'`, [id]);
check("reassignment recorded for rule tuning", (re?.n ?? 0) === 1);

console.log("\n7. no-action close is not a resolution");
id = await mk();
await act(alice.id);
await db.query(`select close_no_action($1,$2,'invalid')`, [id, alice.id]);
const c = await one<{ status: string; close_reason: string }>(
  `select status, close_reason from reports where id=$1`, [id]);
check("status closed_no_action", c?.status === "closed_no_action");
check("reason recorded", c?.close_reason === "invalid");
const inQueue = await one<{ n: number }>(`select count(*)::int n from staff_queue where id=$1`, [id]);
check("drops out of the open queue", (inQueue?.n ?? 1) === 0);

/**
 * The actor is the caller, and the database is what says so.
 *
 * These six functions are SECURITY DEFINER, so RLS never constrained them, and
 * every signed-in staff member holds EXECUTE. Until assert_actor existed, the
 * only thing stopping a person resolving another club's report in someone
 * else's name was the app choosing to pass the right id. The accountability
 * record is what a GM answers "who handled it, and how fast" from — an actor
 * the caller picks makes that record forgeable, which is worse than not having
 * it, because it still looks authoritative.
 */
console.log("\n11. an action is attributed to the person performing it");

const raises = async (sql: string, params: unknown[]) => {
  try { await db.query(sql, params); return null; }
  catch (e) { return (e as { message?: string }).message ?? "raised"; }
};

const fresh = await mk();
await act(alice.id);

// Naming someone else as the actor is the forgery this prevents.
const spoof = await raises(`select acknowledge_report($1,$2)`, [fresh, bob.id]);
check("acting as one person while naming another is refused", spoof !== null,
  "the action was accepted");
check("and says why", Boolean(spoof?.includes("attributed to the person")), spoof ?? "");

// No session at all: the service role has no business doing staff actions.
await db.query(`select set_config('test.uid', '', false)`);
const anon = await raises(`select resolve_report($1,$2,$3)`, [fresh, alice.id, "no session"]);
check("an unauthenticated caller is refused", anon !== null, "the action was accepted");

// A deactivated person keeps a valid session until it expires. Offboarding has
// to stop actions, not just stop pages.
await db.query(`update profiles set active = false where id = $1`, [bob.id]);
await act(bob.id);
const gone = await raises(`select acknowledge_report($1,$2)`, [fresh, bob.id]);
check("a deactivated staff member cannot act", gone !== null, "the action was accepted");
await db.query(`update profiles set active = true where id = $1`, [bob.id]);

// Another club's report must be indistinguishable from one that does not
// exist, or ids become an enumeration oracle.
const other = (await one<{ id: string }>(
  `insert into courses (name, slug, timezone) values ('Rival Oaks','rival-oaks','America/New_York')
   returning id`))!.id;
const otherLoc = (await one<{ id: string }>(
  `insert into locations (course_id, name, hole_number) values ($1,'Hole 1',1) returning id`,
  [other]))!.id;
const otherReport = (await one<{ id: string }>(
  `insert into reports (course_id, location_id, body, status)
   values ($1,$2,'not yours','triaged') returning id`, [other, otherLoc]))!.id;

await act(alice.id);
const cross = await raises(`select acknowledge_report($1,$2)`, [otherReport, alice.id]);
check("another club's report cannot be acted on", cross !== null, "the action was accepted");
check("and is indistinguishable from one that does not exist",
  Boolean(cross?.includes("report not found")), cross ?? "");

const missing = await raises(`select acknowledge_report($1,$2)`,
  ["00000000-0000-0000-0000-0000000000ff", alice.id]);
check("a genuinely missing report gives that same message",
  Boolean(missing?.includes("report not found")), missing ?? "");

// The guard must not have broken the ordinary path it wraps.
await act(alice.id);
const good = await one<{ ok: boolean }>(
  `select * from acknowledge_report($1,$2)`, [fresh, alice.id]);
check("the person themselves can still act", good?.ok === true);

/**
 * Picked up before triage reached it. This is what happened with the demo data
 * cleared: file, see it on the phone within seconds, tap "I've got this" — all
 * before the once-a-minute sweep. route_report used to answer already_triaged
 * to anything past 'new', so the report was never classified, never routed, and
 * nobody was paged. A fast acknowledgement is the product working well, not a
 * reason to skip deciding who owns the problem.
 */
console.log("\n12. a report claimed before triage is still routed");
const early = (await one<{ id: string }>(
  `insert into reports (course_id, location_id, body, status)
   values ($1,$2,'sprinkler stuck on 9, grabbed it straight away','new') returning id`,
  [course, loc]))!.id;
await act(alice.id);
await db.query(`select acknowledge_report($1,$2)`, [early, alice.id]);
const routedEarly = await one<{ department_id: string | null; recipients: number; reason: string }>(
  `select * from route_report($1,'course_maintenance','normal','sprinkler',0.9,'keyword')`, [early]);
check("routing still happens", routedEarly?.reason !== "already_triaged", routedEarly?.reason);
check("and reaches somebody", (routedEarly?.recipients ?? 0) > 0, `${routedEarly?.recipients}`);
const afterEarly = await one<{ status: string; department_id: string | null; category: string | null }>(
  `select status::text, department_id, category from reports where id=$1`, [early]);
check("a department is assigned", afterEarly?.department_id !== null);
check("the category is set", afterEarly?.category === "course_maintenance", afterEarly?.category ?? "null");
check("the claim is not lost — status stays acknowledged", afterEarly?.status === "acknowledged", afterEarly?.status);
const secondPass = await one<{ reason: string }>(
  `select reason from route_report($1,'course_maintenance','normal','sprinkler',0.9,'keyword')`, [early]);
check("a second pass is still idempotent", secondPass?.reason === "already_triaged", secondPass?.reason);

// Finished before triage: leave it alone, and say why.
const done = await mk();
await act(alice.id);
await db.query(`update reports set triage_source = null, department_id = null where id=$1`, [done]);
await db.query(`select resolve_report($1,$2,$3)`, [done, alice.id, "fixed on the spot"]);
const closed = await one<{ reason: string; recipients: number }>(
  `select reason, recipients from route_report($1,'course_maintenance','normal','x',0.9,'keyword')`, [done]);
check("a report resolved before triage is not routed", closed?.reason === "already_closed", closed?.reason);
const notesForDone = await one<{ n: number }>(`select count(*)::int n from notifications where report_id=$1`, [done]);
check("and nobody is paged about finished work", (notesForDone?.n ?? -1) === 0, `${notesForDone?.n}`);

/**
 * Handing a report to a named person.
 *
 * The clock behaviour is the part worth pinning: a report acknowledged by one
 * person and handed to another must start the new person's clock, or their
 * response time is invisible and the first person is charged for time they did
 * not own.
 */
console.log("\n13. handing a report to somebody");
const teammate = (await one<{ id: string; full_name: string }>(
  `select id, full_name from profiles where id <> $1 and active limit 1`, [alice.id]))!;
const handed = await mk();
await act(alice.id);
await db.query(`select acknowledge_report($1,$2)`, [handed, alice.id]);
const ackBefore = await one<{ acknowledged_at: string | null }>(
  `select acknowledged_at from reports where id = $1`, [handed]);
check("it starts acknowledged by the first person", ackBefore?.acknowledged_at !== null);

const assigned = await one<{ ok: boolean; assignee_name: string }>(
  `select * from assign_report($1,$2,$3)`, [handed, alice.id, teammate.id]);
check("assigning succeeds", assigned?.ok === true);
check("and names who now has it", assigned?.assignee_name === teammate.full_name, assigned?.assignee_name);

const handedAfter = await one<{ claimed_by: string; acknowledged_at: string | null; status: string }>(
  `select claimed_by, acknowledged_at, status::text from reports where id = $1`, [handed]);
check("the report is theirs now", handedAfter?.claimed_by === teammate.id);
check("the acknowledgement clock is reset for them", handedAfter?.acknowledged_at === null,
  "the new owner inherited the old timestamp");
check("and it is waiting to be picked up again", handedAfter?.status === "triaged", handedAfter?.status);

const notified = await one<{ n: number }>(
  `select count(*)::int n from notifications where report_id = $1 and profile_id = $2`,
  [handed, teammate.id]);
check("they are told", (notified?.n ?? 0) >= 1);

const handoverEv = await one<{ payload: Record<string, unknown> }>(
  `select payload from report_events
    where report_id = $1 and type = 'reassigned' order by created_at desc limit 1`, [handed]);
check("the handover is on the record, naming both ends",
  handoverEv?.payload?.kind === "person" && handoverEv?.payload?.to === teammate.id && handoverEv?.payload?.from === alice.id,
  JSON.stringify(handoverEv?.payload ?? {}));

// It appears in the new owner's queue, which is the whole point of the feature
// and the assertion the original Pro Shop bug says to make.
await act(teammate.id);
const theirs = await one<{ n: number }>(
  `select count(*)::int n from my_queue where id = $1`, [handed]);
check("it is in their own queue", (theirs?.n ?? 0) === 1, `${theirs?.n}`);

console.log("\n14. and what assigning refuses");
const refuses = async (sql: string, p: unknown[]) => {
  try { await db.query(sql, p); return null; } catch (e) { return (e as Error).message; }
};
await act(alice.id);
const same = await one<{ ok: boolean }>(
  `select ok from assign_report($1,$2,$3)`, [handed, alice.id, teammate.id]);
check("handing it to the person who already has it changes nothing", same?.ok === false);

await db.query(`update profiles set active = false where id = $1`, [teammate.id]);
const offboarded = await refuses(`select assign_report($1,$2,$3)`, [handed, alice.id, teammate.id]);
check("cannot hand work to someone who has been offboarded", offboarded !== null, "accepted");
await db.query(`update profiles set active = true where id = $1`, [teammate.id]);

const outsider = (await one<{ id: string }>(
  `insert into courses (name, slug, timezone) values ('Rival Two','rival-two','America/New_York')
   returning id`))!.id;
const outsiderProfile = (await one<{ id: string }>(
  `insert into auth.users (id, email) values (gen_random_uuid(), 'rival@example.com') returning id`))!.id;
await db.query(
  `insert into profiles (id, course_id, full_name, role) values ($1,$2,'Rival Person','staff')`,
  [outsiderProfile, outsider]);
const crossClub = await refuses(`select assign_report($1,$2,$3)`, [handed, alice.id, outsiderProfile]);
check("cannot hand work to another club's staff", crossClub !== null, "accepted");

const finished = await mk();
await act(alice.id);
await db.query(`select resolve_report($1,$2,$3)`, [finished, alice.id, "done"]);
const onClosed = await refuses(`select assign_report($1,$2,$3)`, [finished, alice.id, teammate.id]);
check("cannot hand somebody finished work", onClosed !== null, "accepted");

await db.query(`select set_config('test.uid', '', false)`);
const noSession = await refuses(`select assign_report($1,$2,$3)`, [handed, alice.id, teammate.id]);
check("an unauthenticated caller cannot assign", noSession !== null, "accepted");

/**
 * A shared counter login never owns a report.
 *
 * The pro shop browser is signed in as one account all day, used by whoever is
 * behind the counter. If that account claims, "who handled it" is answered by
 * "Pro Shop Counter", which is nobody — the accountability record this product
 * is sold on stops at the counter. So a station hands the report to a named
 * person: they become the owner and are paged, and the hand-over itself is on
 * the record with the station as its actor. me() has to say the account is a
 * station for the app to offer that instead of a claim.
 */
console.log("\n15. a shared station hands work to a named person, never claims it");
const stationUser = (await one<{ id: string }>(
  `insert into auth.users (id, email) values (gen_random_uuid(), 'counter-test@example.com') returning id`))!.id;
await db.query(
  `insert into profiles (id, course_id, full_name, role, account_kind)
   values ($1,$2,'Test Counter','staff','station')`, [stationUser, course]);

await act(stationUser);
const meAsStation = await one<{ account_kind: string; full_name: string }>(`select * from me()`);
check("me() says the account is a station", meAsStation?.account_kind === "station",
  meAsStation?.account_kind ?? "no row");

const viaStation = await mk();
const handoff = await one<{ ok: boolean; assignee_name: string }>(
  `select * from assign_report($1,$2,$3)`, [viaStation, stationUser, bob.id]);
check("the hand-off succeeds", handoff?.ok === true);
check("and names the person", handoff?.assignee_name === bob.full_name, handoff?.assignee_name);

const afterHandoff = await one<{ claimed_by: string }>(
  `select claimed_by from reports where id = $1`, [viaStation]);
check("the named person owns it, not the station", afterHandoff?.claimed_by === bob.id,
  afterHandoff?.claimed_by === stationUser ? "the station claimed it" : String(afterHandoff?.claimed_by));

const pagedPerson = await one<{ n: number }>(
  `select count(*)::int n from notifications
    where report_id = $1 and profile_id = $2 and status = 'queued'`, [viaStation, bob.id]);
check("a notification is queued for the person", (pagedPerson?.n ?? 0) === 1, `${pagedPerson?.n}`);
const pagedStation = await one<{ n: number }>(
  `select count(*)::int n from notifications where report_id = $1 and profile_id = $2`,
  [viaStation, stationUser]);
check("and none for the station", (pagedStation?.n ?? -1) === 0, `${pagedStation?.n}`);

const stationEv = await one<{ actor_id: string; payload: Record<string, unknown> }>(
  `select actor_id, payload from report_events
    where report_id = $1 and type = 'reassigned' order by created_at desc limit 1`, [viaStation]);
check("the hand-over is attributed to the station", stationEv?.actor_id === stationUser,
  String(stationEv?.actor_id));
check("and says who it went to", stationEv?.payload?.to === bob.id, JSON.stringify(stationEv?.payload ?? {}));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
