/** Escalation, against throwaway Postgres. */
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
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

const course = (await one<{ id: string }>(`select id from courses limit 1`))!.id;
const loc = (await one<{ id: string }>(`select id from locations where hole_number=7`))!.id;
const maint = (await one<{ id: string }>(`select id from departments where key='maintenance'`))!.id;

// Quiet hours off, so timing is the only variable under test.
await db.query(`update courses set settings = settings - 'quiet_hours'`);

const mk = async (
  agoMins: number, acked: boolean, urgency: "normal" | "urgent" = "normal",
  category = "course_maintenance", confidence: number | null = null,
) =>
  (await one<{ id: string }>(
  `insert into reports (course_id, location_id, body, status, department_id, category,
                        created_at, acknowledged_at, urgency, ai_confidence)
   values ($1,$2,'escalation test',$3,$4,$8,
           now() - make_interval(mins => $5::int),
           case when $6 then now() - make_interval(mins => ($5/2)::int) else null end,
           $7::report_urgency, $9::numeric)
   returning id`,
  [course, loc, acked ? "acknowledged" : "triaged", maint, agoMins, acked, urgency, category, confidence]))!.id;

console.log("\n1. inside the SLA — nothing happens");
let id = await mk(5, false);
await db.query(`select * from escalate_reports()`);
let lvl = await one<{ escalation_level: number }>(`select escalation_level from reports where id=$1`, [id]);
check("no escalation while inside the acknowledge SLA", lvl?.escalation_level === 0, String(lvl?.escalation_level));

console.log("\n2. past the acknowledge SLA — climbs to a supervisor");
id = await mk(45, false);
await db.query(`select * from escalate_reports()`);
lvl = await one(`select escalation_level from reports where id=$1`, [id]);
check("escalated to level 1", lvl?.escalation_level === 1, String(lvl?.escalation_level));
const notified = await one<{ n: number }>(`select count(*)::int n from notifications where report_id=$1`, [id]);
check("leadership was actually notified", (notified?.n ?? 0) > 0, String(notified?.n));
const ev = await one<{ n: number }>(
  `select count(*)::int n from report_events where report_id=$1 and type='escalated'`, [id]);
check("escalation recorded in the event trail", (ev?.n ?? 0) === 1);

console.log("\n3. running again does not escalate the same report twice");
const before = (await one<{ n: number }>(`select count(*)::int n from notifications where report_id=$1`, [id]))!.n;
await db.query(`select * from escalate_reports()`);
const after = (await one<{ n: number }>(`select count(*)::int n from notifications where report_id=$1`, [id]))!.n;
check("idempotent per level", before === after, `${before} -> ${after}`);

console.log("\n4. long overdue and still unresolved — climbs to management");
id = await mk(600, true);
await db.query(`select * from escalate_reports()`);
lvl = await one(`select escalation_level from reports where id=$1`, [id]);
check("escalated to level 2", (lvl?.escalation_level ?? 0) >= 1, String(lvl?.escalation_level));

console.log("\n5. quiet hours suppress escalation");
await db.query(`update courses set settings = jsonb_set(settings,'{quiet_hours}',
  jsonb_build_object('start','00:00','end','23:59'))`);
id = await mk(600, false);
await db.query(`select * from escalate_reports()`);
lvl = await one(`select escalation_level from reports where id=$1`, [id]);
check("nobody is paged during quiet hours", lvl?.escalation_level === 0, String(lvl?.escalation_level));

console.log("\n6. resolved reports are never escalated");
await db.query(`update courses set settings = settings - 'quiet_hours'`);
id = await mk(600, true);
await db.query(`update reports set status='resolved', resolved_at=now() where id=$1`, [id]);
await db.query(`select * from escalate_reports()`);
lvl = await one(`select escalation_level from reports where id=$1`, [id]);
check("closed work is left alone", lvl?.escalation_level === 0, String(lvl?.escalation_level));

console.log("\n7. urgent reports escalate through quiet hours");
// Quiet hours all day, as in 5. A lightning strike at 20:30 must not wait for
// 06:00; a bunker rake still does.
//
// Confidence 0.9: since 20260906110000 an urgent report only bypasses quiet
// hours when the classifier stood behind it (>= 0.8) or the category is
// safety. With no confidence at all this report would be a guess, and section
// 8 pins that a guess waits. This section is about the clock, so the report
// is given the confidence a keyword rule would have written.
await db.query(`update courses set settings = jsonb_set(settings,'{quiet_hours}',
  jsonb_build_object('start','00:00','end','23:59'))`);
const urgentId = await mk(600, false, "urgent", "course_maintenance", 0.9);
const normalId = await mk(600, false, "normal");
await db.query(`select * from escalate_reports()`);
lvl = await one(`select escalation_level from reports where id=$1`, [urgentId]);
check("an urgent report escalates inside quiet hours", (lvl?.escalation_level ?? 0) >= 1, String(lvl?.escalation_level));
const urgentNotified = await one<{ n: number }>(`select count(*)::int n from notifications where report_id=$1`, [urgentId]);
check("and somebody was actually paged", (urgentNotified?.n ?? 0) > 0, String(urgentNotified?.n));
lvl = await one(`select escalation_level from reports where id=$1`, [normalId]);
check("a normal report still waits for morning", lvl?.escalation_level === 0, String(lvl?.escalation_level));
await db.query(`update courses set settings = settings - 'quiet_hours'`);

console.log("\n8. the quiet-hours bypass belongs to data, not the model");
// The classifier writes urgency. A hallucinated "urgent" on a lost glove at
// 22:00 must not page every leader an hour later. What may cross quiet hours:
// a safety category (a routing_rules key the club owns), or an urgent call the
// classifier itself put at 0.8 or better. A low-confidence urgent is a guess.
await db.query(`update courses set settings = jsonb_set(settings,'{quiet_hours}',
  jsonb_build_object('start','00:00','end','23:59'))`);
const guessId    = await mk(600, false, "urgent", "course_maintenance", 0.5);
const sureId     = await mk(600, false, "urgent", "course_maintenance", 0.9);
const safetyId   = await mk(600, false, "normal", "safety");
const ordinaryId = await mk(600, false, "normal", "course_maintenance");
await db.query(`select * from escalate_reports()`);
const level = async (id: string) =>
  (await one<{ escalation_level: number }>(`select escalation_level from reports where id=$1`, [id]))?.escalation_level;
const paged = async (id: string) =>
  (await one<{ n: number }>(`select count(*)::int n from notifications where report_id=$1`, [id]))?.n ?? 0;
check("urgent at confidence 0.5 waits for morning", (await level(guessId)) === 0, String(await level(guessId)));
check("and paged nobody", (await paged(guessId)) === 0, String(await paged(guessId)));
check("urgent at confidence 0.9 escalates inside quiet hours", ((await level(sureId)) ?? 0) >= 1, String(await level(sureId)));
check("and somebody was paged", (await paged(sureId)) > 0, String(await paged(sureId)));
check("a normal safety report escalates inside quiet hours", ((await level(safetyId)) ?? 0) >= 1, String(await level(safetyId)));
check("and somebody was paged for it", (await paged(safetyId)) > 0, String(await paged(safetyId)));
check("a normal maintenance report waits for morning", (await level(ordinaryId)) === 0, String(await level(ordinaryId)));
await db.query(`update courses set settings = settings - 'quiet_hours'`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
