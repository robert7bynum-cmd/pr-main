/**
 * Routing tests against a throwaway Postgres. No Supabase, no API calls.
 * Focus is the failure mode that hides: a report nobody is told about.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort())
  await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
await db.exec(readFileSync("supabase/seed.sql", "utf8"));

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0];

const course = (await one<{ id: string }>(`select id from courses limit 1`))!.id;
const loc = (await one<{ id: string }>(`select id from locations where hole_number = 7`))!.id;
const qr = (await one<{ id: string }>(`select id from qr_codes where location_id = $1`, [loc]))!.id;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  -> " + detail}`);
};

async function newReport(body: string) {
  const r = (await one<{ id: string }>(
    `insert into reports (course_id, location_id, qr_code_id, body)
     values ($1,$2,$3,$4) returning id`, [course, loc, qr, body]))!;
  await db.query(`insert into triage_queue (report_id) values ($1)`, [r.id]);
  return r.id;
}
const route = (id: string, cat: string) =>
  one<{ department_id: string; recipients: number; reason: string }>(
    `select * from route_report($1,$2,'normal','summary',0.9,'keyword')`, [id, cat]);

console.log("\n1. normal path — maintenance has staff on duty");
await db.exec(`update profiles set on_duty = true`);
let id = await newReport("sprinkler stuck on 7");
let res = await route(id, "course_maintenance");
check("routes to a department", !!res?.department_id);
check("notifies at least one person", (res?.recipients ?? 0) > 0, `got ${res?.recipients}`);
check("reason is the normal path", res?.reason === "on_duty_department", res?.reason);

console.log("\n2. target department has nobody on duty");
const maint = (await one<{ id: string }>(`select id from departments where key='maintenance'`))!.id;
await db.query(
  `update profiles set on_duty = false where id in
     (select profile_id from staff_departments where department_id = $1)`, [maint]);
id = await newReport("bunker rake missing on 7");
res = await route(id, "course_maintenance");
check("still notifies someone", (res?.recipients ?? 0) > 0, `got ${res?.recipients}`);
check("climbed the chain", res?.reason !== "on_duty_department", res?.reason);

console.log("\n3. NOBODY on duty anywhere — the silent-failure case");
await db.exec(`update profiles set on_duty = false`);
id = await newReport("cart dead on 7 at 6:40am");
res = await route(id, "cart_issue");
check("still notifies someone", (res?.recipients ?? 0) > 0, `got ${res?.recipients}`);
check("reason says unstaffed", res?.reason === "unstaffed_all_leadership", res?.reason);
const unstaffed = await one<{ n: number }>(
  `select count(*)::int n from report_events where report_id=$1 and type='unstaffed'`, [id]);
check("writes an unstaffed event so a GM can see why", (unstaffed?.n ?? 0) === 1);

console.log("\n4. idempotency — both delivery paths hit the same report");
await db.exec(`update profiles set on_duty = true`);
id = await newReport("duplicate delivery test");
const first = await route(id, "pro_shop");
const second = await route(id, "pro_shop");
check("second call is a no-op", second?.reason === "already_triaged", second?.reason);
const notes = await one<{ n: number }>(
  `select count(*)::int n from notifications where report_id=$1`, [id]);
check("nobody is notified twice", (notes?.n ?? 0) === (first?.recipients ?? -1),
  `${notes?.n} vs ${first?.recipients}`);

console.log("\n5. unmapped category falls back rather than dropping");
id = await newReport("something with no routing rule");
res = await route(id, "not_a_real_category");
check("still routed", (res?.recipients ?? 0) > 0, `got ${res?.recipients}`);
const cat = await one<{ category: string }>(`select category from reports where id=$1`, [id]);
check("category lands in needs_review", cat?.category === "needs_review", cat?.category);

console.log("\n6. queue claiming");
const a = await newReport("queue a"); await newReport("queue b");
const batch = await db.query<{ report_id: string }>(`select * from claim_triage_batch(10)`);
check("claims pending work", batch.rows.length >= 2, `${batch.rows.length}`);
const again = await db.query(`select * from claim_triage_batch(10)`);
check("does not re-claim in-flight work", again.rows.length === 0, `${again.rows.length}`);

console.log("\n7. failure backoff and dead-letter");
for (let i = 0; i < 6; i++) {
  await db.query(`update triage_queue set status='pending', next_attempt_at=now() where report_id=$1`, [a]);
  await db.query(`select * from claim_triage_batch(50)`);
  await db.query(`select fail_triage($1,'boom')`, [a]);
}
const dead = await one<{ status: string; attempts: number }>(
  `select status, attempts from triage_queue where report_id=$1`, [a]);
check("parks in dead_letter after repeated failure", dead?.status === "dead_letter",
  `${dead?.status} after ${dead?.attempts}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
