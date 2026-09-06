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

/**
 * Deactivating has to end access, not merely mark it.
 *
 * It used to flip a flag. Every guard reads that flag, so the person could do
 * nothing — but the session they were already holding stayed valid for up to an
 * hour, and in that window they could still READ the club's reports. Their
 * phone also kept its push subscription. A departed employee reading the
 * course's traffic on the way out is not something anyone would think to check.
 */
console.log("\n8. deactivating ends the session and the pages");
{
  const victim = (await one<{ id: string }>(
    `select id from profiles where role = 'staff' and active limit 1`))!.id;
  await db.query(`insert into auth.sessions (user_id) values ($1)`, [victim]);
  await db.query(
    `insert into push_subscriptions (profile_id, endpoint, p256dh, auth)
     values ($1, 'https://example.test/offboard', 'p', 'a')`, [victim]);

  await act(manager);
  await db.query(`select set_staff_active($1, false)`, [victim]);

  const sessions = await one<{ n: number }>(
    `select count(*)::int n from auth.sessions where user_id = $1`, [victim]);
  check("their session is gone, not left to expire", (sessions?.n ?? -1) === 0, `${sessions?.n}`);

  const devices = await one<{ n: number }>(
    `select count(*)::int n from push_subscriptions where profile_id = $1`, [victim]);
  check("their devices stop being paged", (devices?.n ?? -1) === 0, `${devices?.n}`);

  const ev = await one<{ detail: Record<string, unknown> }>(
    `select detail from admin_events
      where subject_id = $1 and type = 'staff_deactivated'
      order by created_at desc limit 1`, [victim]);
  check("and the record says what was revoked",
    Number(ev?.detail?.sessions_ended ?? -1) === 1 && Number(ev?.detail?.devices_removed ?? -1) === 1,
    JSON.stringify(ev?.detail ?? {}));

  // Reactivating must not resurrect a session somebody already lost.
  await db.query(`select set_staff_active($1, true)`, [victim]);
  const after = await one<{ n: number }>(
    `select count(*)::int n from auth.sessions where user_id = $1`, [victim]);
  check("reactivating does not hand the old session back", (after?.n ?? -1) === 0, `${after?.n}`);
}

/**
 * An invitation link IS a session for whoever's email is on it. So minting one
 * is managing that person, and the same guard applies: your club only, and a
 * manager cannot reach an owner. Before this, create_staff_invite checked only
 * that the caller was management — a manager could type the owner's address,
 * redeem the link, and become the owner.
 */
console.log("\n9. invitations are scoped to people you may manage");
{
  const errorOf = async (sql: string, p: unknown[] = []) => {
    try { await db.query(sql, p); return null; } catch (e) { return (e as Error).message; }
  };
  const owner = (await one<{ id: string; email: string }>(
    `select id, email from profiles where role = 'owner' and active limit 1`))!;
  const managerEmail = (await one<{ email: string }>(
    `select email from profiles where id = $1`, [manager]))!.email;
  const staffEmail = (await one<{ email: string }>(
    `select email from profiles where id = $1 and active`, [staff]))!.email;
  await db.query(`update profiles set email = 'x@other.com' where id = $1`, [otherStaff]);

  await act(manager);
  check("a manager cannot mint a link for the owner",
    await throws(`select create_staff_invite($1)`, [owner.email]));

  const foreign = await errorOf(`select create_staff_invite('x@other.com')`);
  const unknown = await errorOf(`select create_staff_invite('nobody@nowhere.test')`);
  check("nor for someone at another club", foreign !== null);
  check("nor for an address that belongs to nobody", unknown !== null);
  check("and the two refusals read the same, so emails cannot be probed",
    foreign !== null && foreign === unknown, `${foreign} vs ${unknown}`);
  check("nothing was recorded for any of them", (await one<{ n: number }>(
    `select count(*)::int n from staff_invites`))!.n === 0);

  const forStaff = await one<{ t: string }>(`select create_staff_invite($1) t`, [staffEmail]);
  check("a manager can mint for staff at their own club", Boolean(forStaff?.t));

  await db.query(`select invite_staff('newhire@beaconhillgolfva.com', 'New Hire', 'staff')`);
  const forPending = await one<{ t: string }>(
    `select create_staff_invite('newhire@beaconhillgolfva.com') t`);
  check("and for someone invited who has not signed in yet", Boolean(forPending?.t));

  const again = await one<{ t: string }>(`select create_staff_invite($1) t`, [staffEmail]);
  const retired = await one<{ used_at: string | null }>(
    `select used_at from staff_invites where token = $1`, [forStaff!.t]);
  check("minting again retires the earlier link", Boolean(again?.t) && retired?.used_at !== null);

  await act(owner.id);
  const forManager = await one<{ t: string }>(`select create_staff_invite($1) t`, [managerEmail]);
  check("an owner can mint for a manager", Boolean(forManager?.t));

  const redeemed = await one<{ e: string }>(`select redeem_staff_invite($1) e`, [forManager!.t]);
  check("redeeming returns the address the link was minted for", redeemed?.e === managerEmail,
    `${redeemed?.e}`);
  check("and a spent link cannot be redeemed twice",
    await throws(`select redeem_staff_invite($1)`, [forManager!.t]));

  await act(manager);
  check("inviting an address that already has an active account is refused",
    await throws(`select invite_staff($1, 'Impostor', 'staff')`, [owner.email]));
  check("even at a lower role for an ordinary colleague",
    await throws(`select invite_staff($1, 'Again', 'staff')`, [staffEmail]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
