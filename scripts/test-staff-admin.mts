/**
 * Privilege guards on staff management.
 *
 * These are the checks that stop a manager escalating themselves, reaching into
 * another club, or locking themselves out. Each one is a specific attack, so
 * each gets a test.
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

const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };
const act = async (uid: string) => { await db.query(`select set_config('test.uid', $1, false)`, [uid]); };
const throws = async (sql: string, p: unknown[] = []) => {
  try { await db.query(sql, p); return false; } catch { return true; }
};

const course = (await one<{ id: string }>(`select id from courses limit 1`))!.id;
const manager = (await one<{ id: string }>(`select id from profiles where role='manager' limit 1`))!.id;
const staff = (await one<{ id: string }>(`select id from profiles where role='staff' limit 1`))!.id;
const supervisor = (await one<{ id: string }>(`select id from profiles where role='supervisor' limit 1`))!.id;

// A second club, to prove isolation is enforced inside the functions.
const other = (await one<{ id: string }>(
  `insert into courses (slug, name) values ('other-club','Other Club') returning id`))!.id;
const otherAuth = (await one<{ id: string }>(
  `insert into auth.users (id, email, aud, role, confirmation_token, recovery_token,
     email_change_token_new, email_change)
   values (gen_random_uuid(),'x@other.com','authenticated','authenticated','','','','')
   returning id`))!.id;
const otherStaff = (await one<{ id: string }>(
  `insert into profiles (id, course_id, full_name, role) values ($1,$2,'Other Person','staff')
   returning id`, [otherAuth, other]))!.id;

console.log("\n1. only management can manage staff");
await act(staff);
check("a staff member cannot invite", await throws(`select invite_staff('x@y.com','X','staff')`));
check("a staff member cannot deactivate anyone", await throws(`select set_staff_active($1,false)`, [supervisor]));

console.log("\n2. self-escalation is blocked");
await act(manager);
check("cannot change your own role", await throws(`select set_staff_role($1,'owner')`, [manager]));
check("cannot deactivate yourself", await throws(`select set_staff_active($1,false)`, [manager]));

console.log("\n3. a manager cannot mint or alter an owner");
check("cannot promote someone to owner", await throws(`select set_staff_role($1,'owner')`, [staff]));
check("cannot invite an owner", await throws(`select invite_staff('o@y.com','O','owner')`));

console.log("\n4. clubs are isolated inside the function, not by the caller");
check("cannot deactivate another club's staff", await throws(`select set_staff_active($1,false)`, [otherStaff]));
check("cannot change another club's staff role", await throws(`select set_staff_role($1,'supervisor')`, [otherStaff]));
const stillActive = await one<{ active: boolean }>(`select active from profiles where id=$1`, [otherStaff]);
check("the other club's record is untouched", stillActive?.active === true);

console.log("\n5. departments must belong to this club");
const otherDept = (await one<{ id: string }>(
  `insert into departments (course_id, key, name) values ($1,'x','X') returning id`, [other]))!.id;
check("cannot attach a foreign department", await throws(`select set_staff_departments($1, $2::uuid[])`, [staff, [otherDept]]));

console.log("\n6. legitimate changes work, and are recorded");
await db.query(`select set_staff_role($1,'supervisor')`, [staff]);
const role = await one<{ role: string }>(`select role from profiles where id=$1`, [staff]);
check("role change applied", role?.role === "supervisor");
const ev = await one<{ n: number; type: string }>(
  `select count(*)::int n, max(type::text) type from admin_events where subject_id=$1`, [staff]);
check("audit event written", (ev?.n ?? 0) >= 1, JSON.stringify(ev));

await db.query(`select set_staff_active($1,false)`, [supervisor]);
const off = await one<{ active: boolean; on_duty: boolean }>(
  `select active, on_duty from profiles where id=$1`, [supervisor]);
check("deactivation also clears on-duty", off?.active === false && off?.on_duty === false);

console.log("\n7. the roster is scoped to the caller's club");
await act(manager);
const roster = await db.query<{ full_name: string }>(`select * from staff_roster()`);
check("roster returns this club's staff", roster.rows.length > 0, String(roster.rows.length));
check("and nobody from the other club", !roster.rows.some(r => r.full_name === "Other Person"));

console.log("\n8. routing rules: guards on the table that decides who gets paged");
await act(manager);
const dept = (await one<{ id: string }>(`select id from departments where course_id=$1 limit 1`, [course]))!.id;
const rules = (await db.query<{ category: string }>(`select * from routing_rules_for_club()`)).rows;
check("management can read the rules", rules.length > 0, String(rules.length));

const good = JSON.stringify([{ category: rules[0].category, department_id: dept, ack_sla_minutes: 20, resolve_sla_minutes: 120 }]);
await db.query(`select update_routing_rules($1::jsonb)`, [good]);
const after = await one<{ ack_sla_minutes: number }>(
  `select ack_sla_minutes from routing_rules where course_id=$1 and category=$2`, [course, rules[0].category]);
check("a valid change applies", after?.ack_sla_minutes === 20, String(after?.ack_sla_minutes));

const audit = await one<{ n: number }>(
  `select count(*)::int n from admin_events where type='routing_rule_changed'`);
check("the change is audited", (audit?.n ?? 0) >= 1);

check("resolve shorter than acknowledge is refused", await throws(
  `select update_routing_rules($1::jsonb)`,
  [JSON.stringify([{ category: rules[0].category, department_id: dept, ack_sla_minutes: 60, resolve_sla_minutes: 10 }])]));

check("a zero-minute SLA is refused", await throws(
  `select update_routing_rules($1::jsonb)`,
  [JSON.stringify([{ category: rules[0].category, department_id: dept, ack_sla_minutes: 0, resolve_sla_minutes: 60 }])]));

check("another club's department is refused", await throws(
  `select update_routing_rules($1::jsonb)`,
  [JSON.stringify([{ category: rules[0].category, department_id: otherDept, ack_sla_minutes: 15, resolve_sla_minutes: 60 }])]));

await act(staff);
check("a staff member cannot edit rules", await throws(
  `select update_routing_rules($1::jsonb)`,
  [JSON.stringify([{ category: rules[0].category, department_id: dept, ack_sla_minutes: 15, resolve_sla_minutes: 60 }])]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
