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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
