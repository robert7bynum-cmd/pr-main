/**
 * Escalation, against throwaway Postgres, run the way pg_cron actually runs
 * it: call escalate_reports() over and over on rows whose timestamps have
 * been pushed into the past, rather than sleeping in real time.
 *
 * escalate_reports() is the dead-man's switch for a report nobody picked up.
 * "Silence is never a valid outcome" — an unacknowledged report has to reach
 * someone above the person who missed it, an acknowledged one must never be
 * paged again on their behalf, and re-running the sweep on the same window
 * (which pg_cron will, every minute, forever) must not re-notify anyone it
 * already told. This is completely safe to run: everything happens inside a
 * disposable PGlite instance that is thrown away on exit.
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

const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const all = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

const course = (await one<{ id: string }>(`select id from courses limit 1`))!.id;
const loc = (await one<{ id: string }>(`select id from locations where hole_number = 7`))!.id;
const maint = (await one<{ id: string }>(`select id from departments where key = 'maintenance'`))!.id;

// Quiet hours off everywhere in this file: timing is the only variable under
// test, and a 3am run of this script should not get different answers than a
// 3pm one.
await db.query(`update courses set settings = settings - 'quiet_hours'`);

// One cron tick. pg_cron calls this once a minute for real; calling it
// several times in a row with no time passing IS the idempotency test.
const tick = () => all<{ report_id: string; level: number; notified: number }>(`select * from escalate_reports()`);

// A report filed `agoMins` ago, optionally already acknowledged partway
// through that window. Goes through routing_rules for course_maintenance,
// same as a real triaged report — this is not a fixture that skips the part
// of the system being tested.
const mk = async (agoMins: number, acked: boolean) => (await one<{ id: string }>(
  `insert into reports (course_id, location_id, body, status, department_id, category,
                        created_at, acknowledged_at)
   values ($1,$2,'escalation-sim report',$3,$4,'course_maintenance',
           now() - make_interval(mins => $5::int),
           case when $6 then now() - make_interval(mins => ($5/2)::int) else null end)
   returning id`,
  [course, loc, acked ? "acknowledged" : "triaged", maint, agoMins, acked]))!.id;

const levelOf = async (id: string) =>
  (await one<{ escalation_level: number }>(`select escalation_level from reports where id=$1`, [id]))!.escalation_level;
const notifCount = async (id: string) =>
  (await one<{ n: number }>(`select count(*)::int n from notifications where report_id=$1`, [id]))!.n;
const escalatedEvents = async (id: string, level: number) =>
  (await one<{ n: number }>(
    `select count(*)::int n from report_events
      where report_id=$1 and type='escalated' and (payload->>'level')::int = $2`, [id, level]))!.n;

console.log("1. an unacknowledged report escalates once its SLA elapses\n");
{
  const id = await mk(5, false);
  await tick();
  check("still silent inside the SLA window", await levelOf(id) === 0);

  await db.query(`update reports set created_at = now() - interval '45 minutes' where id=$1`, [id]);
  await tick();
  check("escalates to level 1 once the SLA has passed", await levelOf(id) === 1, String(await levelOf(id)));
  check("someone was actually notified, not just flagged", await notifCount(id) > 0, String(await notifCount(id)));
  check("the escalation is in the event trail, not just the column",
    await escalatedEvents(id, 1) === 1);
}

console.log("\n2. acknowledging a report retires the 'nobody picked this up' alarm for good\n");
{
  // Level 1 exists to answer one question — did anyone pick this up? — and
  // acknowledging it answers that question permanently. Filed 45 minutes ago
  // (past the 15-minute ack SLA several times over) and acknowledged 2
  // minutes in, but still well inside the 120-minute resolve SLA, so level 2
  // has no grounds to fire either: this report should sit at level 0
  // forever, no matter how many sweeps run.
  const id = await mk(1, true);
  await db.query(`update reports set created_at = now() - interval '45 minutes',
                                     acknowledged_at = now() - interval '43 minutes'
                   where id=$1`, [id]);
  for (let i = 0; i < 5; i++) await tick();
  check("no level-1 'nobody picked this up' alert, ever, once acknowledged",
    await escalatedEvents(id, 1) === 0);
  check("acknowledged and still inside the resolve SLA: no escalation at all",
    await levelOf(id) === 0, String(await levelOf(id)));
  check("the person who acknowledged it is never paged about their own report",
    await notifCount(id) === 0, String(await notifCount(id)));
}

console.log("\n2b. but acknowledgement does not excuse work that never got finished\n");
{
  // Level 2 asks a different question — is it actually resolved? — which
  // acknowledging does not answer. Left "acknowledged" for a week with
  // nothing further done, it still must reach management: escalation is a
  // safety net for the report, not a reward for whoever claimed it.
  const id = await mk(1, true);
  await db.query(`update reports set created_at = now() - interval '7 days',
                                     acknowledged_at = now() - interval '7 days' + interval '2 minutes'
                   where id=$1`, [id]);
  await tick();
  check("stalled-but-acknowledged work still reaches level 2 eventually",
    await levelOf(id) === 2, String(await levelOf(id)));
  check("it got there without ever firing the level-1 'unpicked' alarm",
    await escalatedEvents(id, 1) === 0);
}

console.log("\n3. the sweep is idempotent — pg_cron runs this every minute forever\n");
{
  const id = await mk(45, false);
  await tick();
  const levelAfterFirst = await levelOf(id);
  const notifAfterFirst = await notifCount(id);
  check("first sweep escalates it", levelAfterFirst === 1, String(levelAfterFirst));

  // Five more ticks, same window, no time passing. This is exactly what the
  // real cron job does between the moment a report crosses its SLA and the
  // moment someone acknowledges it — it must not re-page anyone five times.
  for (let i = 0; i < 5; i++) await tick();
  check("repeated sweeps do not escalate the same report twice",
    await levelOf(id) === levelAfterFirst, String(await levelOf(id)));
  check("and do not duplicate the notifications already sent",
    await notifCount(id) === notifAfterFirst, `${notifAfterFirst} -> ${await notifCount(id)}`);
  check("and do not duplicate the event either",
    await escalatedEvents(id, 1) === 1);
}

console.log("\n4. ignored long enough, escalation climbs to management\n");
{
  const id = await mk(45, false);
  await tick();
  check("first stop is a supervisor", await levelOf(id) === 1, String(await levelOf(id)));
  const notifAtLevel1 = await notifCount(id);

  // Still nobody has acknowledged, and now resolve_sla_minutes has also
  // elapsed. The next tick is the one that reaches level 2 — escalation
  // climbs one rung per sweep, it does not jump straight to the top.
  await db.query(`update reports set created_at = now() - interval '10 hours' where id=$1`, [id]);
  await tick();
  check("a second unattended sweep climbs to level 2", await levelOf(id) === 2, String(await levelOf(id)));
  check("management was notified for the climb", await notifCount(id) > notifAtLevel1);
  check("level 2 has its own event, level 1's is not overwritten",
    await escalatedEvents(id, 1) === 1 && await escalatedEvents(id, 2) === 1);
}

console.log("\n5. a resolved report never escalates, however overdue it looks\n");
{
  const id = await mk(600, true);
  await db.query(`update reports set status='resolved', resolved_at=now() where id=$1`, [id]);
  await tick();
  check("closed work stays closed", await levelOf(id) === 0, String(await levelOf(id)));
  check("and generates no notifications", await notifCount(id) === 0);
}

console.log("\n6. the two response clocks stay separate\n");
{
  // CLAUDE.md, Processing integrity: "created -> resolved is the member's
  // experience; notified -> acknowledged is what a person is accountable
  // for. Charging someone for routing delay is how staff stop trusting the
  // data." Build the exact shape that rule exists to guard against: a report
  // that sat filed for a long time before anyone was told about it (a triage
  // backlog, not this person's fault), picked up fast once they were, and
  // handled fast once picked up.
  const filedAgo = 3 * 60;       // filed 3 hours ago
  const staffTookMinutes = 5;    // but only 5 minutes of that was on the assignee

  const filed = await one<{ id: string; created_at: string }>(
    `insert into reports (course_id, location_id, body, status, department_id, category,
                          created_at, acknowledged_at, resolved_at)
     values ($1,$2,'clock-separation report','resolved',$3,'course_maintenance',
             now() - make_interval(mins => $4::int),
             now() - make_interval(mins => $5::int),
             now())
     returning id, created_at`,
    [course, loc, maint, filedAgo, staffTookMinutes]);
  const id = filed!.id;

  const clocks = await one<{ member_experience: number; staff_handling: number }>(
    `select
        extract(epoch from (resolved_at - created_at))     / 60 as member_experience,
        extract(epoch from (resolved_at - acknowledged_at)) / 60 as staff_handling
       from reports where id = $1`, [id]);

  check("the member's clock reflects the full wait, backlog included",
    Math.round(clocks!.member_experience) === filedAgo, String(clocks!.member_experience));
  check("the staff clock reflects only the time since they had it, not since filing",
    Math.round(clocks!.staff_handling) === staffTookMinutes, String(clocks!.staff_handling));
  check("the two numbers are not the same metric wearing a different label",
    Math.abs(clocks!.member_experience - clocks!.staff_handling) > 60);

  // Prove it end to end through the real per-person accountability view, not
  // just by computing both intervals ourselves — dashboard_by_person is what
  // a manager actually reads, and its own comment promises the fair clock.
  // Give the assignee a throwaway identity with no other resolved reports in
  // the window, so the view's median is exactly this one report's number and
  // nothing seeded is mixed in.
  const authId = (await one<{ id: string }>(
    `insert into auth.users (id, email, aud, role, confirmation_token, recovery_token,
       email_change_token_new, email_change)
     values (gen_random_uuid(),'clock-test@example.com','authenticated','authenticated','','','','')
     returning id`))!.id;
  const assignee = (await one<{ id: string }>(
    `insert into profiles (id, course_id, full_name, role, active)
     values ($1,$2,'Clock Test Assignee','staff',true) returning id`, [authId, course]))!.id;
  await db.query(`update reports set resolved_by = $1 where id = $2`, [assignee, id]);

  const perPerson = await one<{ median_handling_minutes: number }>(
    `select median_handling_minutes from dashboard_by_person where profile_id = $1`, [assignee]);
  check("dashboard_by_person scores this person on handling time, not filing-to-resolve time",
    perPerson !== undefined && Math.abs(Number(perPerson.median_handling_minutes) - staffTookMinutes) <= 1,
    JSON.stringify(perPerson));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
