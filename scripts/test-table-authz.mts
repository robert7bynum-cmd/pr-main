/**
 * Who may write which table, asked as the table would be asked.
 *
 * Every staff action goes through a SECURITY DEFINER function that checks the
 * caller and writes the report_events row the metrics are built from. That was
 * only true of the app: the tables underneath still granted `authenticated`
 * INSERT/UPDATE/DELETE, and the first-day RLS policies let any signed-in staff
 * member use them through PostgREST — set your own `resolved_by`, append a
 * report_events row with the manager's actor_id, register your phone under the
 * manager's profile. 20260906070000 closes both lines. This proves it stays
 * closed, and that the paths the app actually uses still work.
 *
 * Runs as the role PostgREST would run as: set_config('test.uid') stands in for
 * the JWT, `set role authenticated` for the connection. A SECURITY DEFINER
 * function runs as its owner, so those are called with the role reset and only
 * the uid set — exactly as test-staff-admin does.
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
const check = (n: string, ok: boolean, d = "") => { if (ok) pass++; else fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

/** Set the JWT stand-in. Session-scoped, so it survives set role / reset role. */
const uid = async (id: string) => { await db.query(`select set_config('test.uid', $1, false)`, [id]); };

/**
 * Run a statement the way PostgREST would: as `authenticated`, with the uid
 * set. Returns the error message if it was refused, the affected row count if
 * it ran. Always resets the role, even on failure.
 */
type Outcome = { error: string } | { rows: number };
const asUser = async (id: string, sql: string, p: unknown[] = []): Promise<Outcome> => {
  await uid(id);
  await db.query(`set role authenticated`);
  try {
    const r = await db.query(sql, p);
    return { rows: r.affectedRows ?? r.rows.length };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    await db.query(`reset role`);
  }
};
const refused = (o: Outcome, why: string) => "error" in o && o.error.toLowerCase().includes(why);
const describe = (o: Outcome) => "error" in o ? `error: ${o.error}` : `ran, ${o.rows} row(s)`;

const course = (await one<{ id: string }>(`select id from courses limit 1`))!.id;
const manager = (await one<{ id: string }>(
  `select id from profiles where course_id=$1 and role='manager' and active limit 1`, [course]))!.id;
const staff = (await one<{ id: string }>(
  `select id from profiles where course_id=$1 and role='staff' and active limit 1`, [course]))!.id;

// An open, unclaimed report in the club: the thing a staff member would most
// like to mark as their own.
const report = (await one<{ id: string; status: string }>(
  `select id, status::text from reports
    where course_id=$1 and claimed_by is null and resolved_at is null
    order by created_at limit 1`, [course]))!;
const before = await one<{ status: string; claimed_by: string | null; resolved_by: string | null; acknowledged_at: string | null }>(
  `select status::text, claimed_by, resolved_by, acknowledged_at from reports where id=$1`, [report.id]);

console.log("\n1. a staff member cannot rewrite a report directly");
{
  const o = await asUser(staff,
    `update reports set status='resolved', resolved_by=$2, acknowledged_at=now(), claimed_by=$2 where id=$1`,
    [report.id, staff]);
  check("UPDATE reports is refused with permission denied", refused(o, "permission denied"), describe(o));
  const after = await one<typeof before>(
    `select status::text, claimed_by, resolved_by, acknowledged_at from reports where id=$1`, [report.id]);
  check("and the row is exactly as it was", JSON.stringify(after) === JSON.stringify(before),
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const ins = await asUser(staff,
    `insert into reports (course_id, location_id, body, source)
     select $1, id, 'nobody submitted this', 'staff' from locations where course_id=$1 limit 1`, [course]);
  check("INSERT reports is refused too", refused(ins, "permission denied"), describe(ins));
}

console.log("\n2. the metrics table cannot be appended to by hand");
{
  const evBefore = (await one<{ n: number }>(`select count(*)::int n from report_events where report_id=$1`, [report.id]))!.n;
  const o = await asUser(staff,
    `insert into report_events (report_id, course_id, type, actor_id) values ($1, $2, 'acknowledged', $3)`,
    [report.id, course, manager]);
  check("INSERT report_events with the manager's actor_id is refused", refused(o, "permission denied"), describe(o));
  const evAfter = (await one<{ n: number }>(`select count(*)::int n from report_events where report_id=$1`, [report.id]))!.n;
  check("no event was written", evAfter === evBefore, `${evBefore} -> ${evAfter}`);
}

console.log("\n3. a push subscription is yours or nothing");
{
  // The manager's phone, registered legitimately (as the worker would see it).
  await db.query(
    `insert into push_subscriptions (profile_id, endpoint, p256dh, auth)
     values ($1, 'https://example.test/manager-phone', 'p', 'a')`, [manager]);

  const forge = await asUser(staff,
    `insert into push_subscriptions (profile_id, endpoint, p256dh, auth)
     values ($1, 'https://example.test/forged', 'p', 'a')`, [manager]);
  const forged = (await one<{ n: number }>(
    `select count(*)::int n from push_subscriptions where endpoint='https://example.test/forged'`))!.n;
  check("registering a device under the manager's profile_id is refused or writes nothing",
    ("error" in forge || forge.rows === 0) && forged === 0, `${describe(forge)}, ${forged} row(s) exist`);

  // savePushSubscription()'s exact shape: own profile_id, on conflict (endpoint).
  const upsert = `insert into push_subscriptions (profile_id, endpoint, p256dh, auth, failure_count)
                  values ($1, 'https://example.test/own-phone', $2, 'a', 0)
                  on conflict (endpoint) do update
                    set profile_id = excluded.profile_id, p256dh = excluded.p256dh,
                        auth = excluded.auth, failure_count = 0`;
  const first = await asUser(staff, upsert, [staff, "p1"]);
  const second = await asUser(staff, upsert, [staff, "p2"]);
  const own = await one<{ n: number; p256dh: string; failure_count: number }>(
    `select count(*)::int n, max(p256dh) p256dh, max(failure_count) failure_count
       from push_subscriptions where profile_id=$1 and endpoint='https://example.test/own-phone'`, [staff]);
  check("upserting your OWN device works, twice, as one row",
    !("error" in first) && !("error" in second) && own?.n === 1 && own?.p256dh === "p2",
    `${describe(first)}; ${describe(second)}; ${JSON.stringify(own)}`);

  const del = await asUser(staff,
    `delete from push_subscriptions where endpoint='https://example.test/manager-phone'`);
  const still = (await one<{ n: number }>(
    `select count(*)::int n from push_subscriptions where endpoint='https://example.test/manager-phone'`))!.n;
  check("deleting the manager's device affects 0 rows", !("error" in del) && del.rows === 0 && still === 1,
    `${describe(del)}, ${still} row(s) remain`);
}

console.log("\n4. routing rules change through the function or not at all");
{
  const dept = (await one<{ id: string }>(`select id from departments where course_id=$1 limit 1`, [course]))!.id;
  const rule = (await one<{ category: string; ack_sla_minutes: number }>(
    `select category, ack_sla_minutes from routing_rules where course_id=$1 limit 1`, [course]))!;

  const o = await asUser(manager,
    `update routing_rules set ack_sla_minutes = 0 where course_id=$1 and category=$2`,
    [course, rule.category]);
  check("a manager's direct UPDATE is refused with permission denied", refused(o, "permission denied"), describe(o));
  const unchanged = await one<{ ack_sla_minutes: number }>(
    `select ack_sla_minutes from routing_rules where course_id=$1 and category=$2`, [course, rule.category]);
  check("the SLA is untouched", unchanged?.ack_sla_minutes === rule.ack_sla_minutes, String(unchanged?.ack_sla_minutes));

  // The front door still opens. SECURITY DEFINER runs as owner, so only the uid is set.
  await uid(manager);
  const target = rule.ack_sla_minutes === 20 ? 25 : 20;
  await db.query(`select update_routing_rules($1::jsonb)`, [JSON.stringify([
    { category: rule.category, department_id: dept, ack_sla_minutes: target, resolve_sla_minutes: 240 },
  ])]);
  const after = await one<{ ack_sla_minutes: number }>(
    `select ack_sla_minutes from routing_rules where course_id=$1 and category=$2`, [course, rule.category]);
  check("update_routing_rules() still applies the change", after?.ack_sla_minutes === target, String(after?.ack_sla_minutes));
  const audited = (await one<{ n: number }>(
    `select count(*)::int n from admin_events where type='routing_rule_changed' and actor_id=$1`, [manager]))!.n;
  check("and it is audited", audited >= 1, String(audited));
}

console.log("\n5. the queues still read");
{
  const mine = await asUser(staff, `select count(*)::int n from my_queue`);
  check("my_queue as staff", !("error" in mine), describe(mine));
  const team = await asUser(staff, `select count(*)::int n from staff_queue`);
  check("staff_queue as staff", !("error" in team), describe(team));
  const reports = await asUser(staff, `select count(*)::int n from reports where course_id=$1`, [course]);
  check("reports (what realtime subscribes to) as staff", !("error" in reports), describe(reports));
}

console.log("\n6. the legitimate path: acknowledge through the function");
{
  await uid(staff);
  const ack = await one<{ ok: boolean; claimed_by_name: string }>(
    `select * from acknowledge_report($1, $2)`, [report.id, staff]);
  check("acknowledge_report() returns ok", ack?.ok === true, JSON.stringify(ack));
  const row = await one<{ claimed_by: string | null; status: string; acknowledged_at: string | null }>(
    `select claimed_by, status::text, acknowledged_at from reports where id=$1`, [report.id]);
  check("the row now shows claimed_by = that staff member",
    row?.claimed_by === staff && row?.status === "acknowledged" && row?.acknowledged_at !== null, JSON.stringify(row));
  const ev = (await one<{ n: number }>(
    `select count(*)::int n from report_events where report_id=$1 and type='acknowledged' and actor_id=$2`,
    [report.id, staff]))!.n;
  check("and the event the metrics derive from was written by the function", ev === 1, String(ev));
}

console.log("\n7. the write grants are gone, not merely unreachable");
{
  const LOCKED = [
    "reports", "report_events", "routing_rules", "admin_events", "notifications",
    "system_alerts", "system_heartbeats", "triage_keywords", "staff_departments", "courses",
  ];
  const { rows: held } = await db.query<{ tbl: string; priv: string }>(`
    select t.tbl, p.priv
      from (values ${LOCKED.map((t) => `('${t}')`).join(",")}) t(tbl)
      cross join (values ('insert'),('update'),('delete')) p(priv)
     where to_regclass('public.' || t.tbl) is not null
       and has_table_privilege('authenticated', 'public.' || t.tbl, p.priv)`);
  check("authenticated holds no insert/update/delete on the ten locked tables",
    held.length === 0, held.map((h) => `${h.priv} ${h.tbl}`).join(", "));

  const { rows: missing } = await db.query<{ tbl: string }>(`
    select t.tbl from (values ${LOCKED.map((t) => `('${t}')`).join(",")}) t(tbl)
     where to_regclass('public.' || t.tbl) is null`);
  check("every table in the list exists (a typo would pass vacuously)", missing.length === 0,
    missing.map((m) => m.tbl).join(", "));

  const { rows: policies } = await db.query<{ tablename: string; policyname: string }>(`
    select tablename, policyname from pg_policies
     where schemaname='public' and cmd <> 'SELECT'
       and tablename in ('reports','report_events','routing_rules')`);
  check("no write policy remains on reports, report_events or routing_rules",
    policies.length === 0, policies.map((p) => `${p.tablename}.${p.policyname}`).join(", "));
}

/**
 * The five tables 20260906070000 left open because mgmt_write was "still their
 * only write path". Nothing in the app wrote them; a manager with a session
 * could re-point a placard, deactivate every code in the club, or rewrite a
 * pending invitation's role before it was claimed, with no audit row.
 * 20260906100000 drops the policy and the grants. Reads must survive: the
 * placard sheet, the staff page and the rules editor all read these tables,
 * and resetPassword() reads pending_profiles — as management only.
 */
console.log("\n8. club configuration is read-only through the API");
{
  const FIVE = ["departments", "locations", "qr_codes", "venues", "pending_profiles"];

  // Something on every table for the manager to read. The seed fills four of
  // them; pending_profiles is empty, so an invitation goes in through the
  // function, as the app would send it.
  await uid(manager);
  await db.query(`select invite_staff('posture-probe@beaconhillgolfva.com', 'Posture Probe', 'staff')`);

  for (const t of FIVE) {
    const upd = await asUser(manager, `update ${t} set course_id = course_id where course_id = $1`, [course]);
    check(`a manager's direct UPDATE ${t} is refused with permission denied`,
      refused(upd, "permission denied"), describe(upd));
    const del = await asUser(manager, `delete from ${t} where course_id = $1`, [course]);
    check(`and DELETE ${t} likewise`, refused(del, "permission denied"), describe(del));

    await uid(manager);
    await db.query(`set role authenticated`);
    try {
      const { rows } = await db.query(`select * from ${t} where course_id = $1 limit 5`, [course]);
      check(`SELECT ${t} as a manager still returns rows`, rows.length > 0, `${rows.length} row(s)`);
    } catch (e) {
      check(`SELECT ${t} as a manager still returns rows`, false, (e as Error).message);
    } finally {
      await db.query(`reset role`);
    }
  }

  // An unclaimed invitation carries a colleague's email and phone: management
  // reads it, ordinary staff see nothing — the read mgmt_write's ALL used to
  // provide, now stated as mgmt_read and nothing more.
  await uid(staff);
  await db.query(`set role authenticated`);
  try {
    const { rows } = await db.query(`select * from pending_profiles`);
    check("SELECT pending_profiles as staff returns no rows, without error", rows.length === 0, `${rows.length} row(s)`);
  } catch (e) {
    check("SELECT pending_profiles as staff returns no rows, without error", false, (e as Error).message);
  } finally {
    await db.query(`reset role`);
  }

  const { rows: held } = await db.query<{ tbl: string; priv: string }>(`
    select t.tbl, p.priv
      from (values ${FIVE.map((t) => `('${t}')`).join(",")}) t(tbl)
      cross join (values ('insert'),('update'),('delete')) p(priv)
     where has_table_privilege('authenticated', 'public.' || t.tbl, p.priv)`);
  check("authenticated holds no insert/update/delete on the five configuration tables",
    held.length === 0, held.map((h) => `${h.priv} ${h.tbl}`).join(", "));

  const { rows: unreadable } = await db.query<{ tbl: string }>(`
    select t.tbl from (values ${FIVE.map((t) => `('${t}')`).join(",")}) t(tbl)
     where not has_table_privilege('authenticated', 'public.' || t.tbl, 'select')`);
  check("but still holds SELECT on all five (the app reads them)",
    unreadable.length === 0, unreadable.map((u) => u.tbl).join(", "));

  const { rows: policies } = await db.query<{ tablename: string; policyname: string; cmd: string }>(`
    select tablename, policyname, cmd from pg_policies
     where schemaname='public' and cmd <> 'SELECT'
       and tablename in (${FIVE.map((t) => `'${t}'`).join(",")})`);
  check("no write policy remains on any of the five",
    policies.length === 0, policies.map((p) => `${p.tablename}.${p.policyname} (${p.cmd})`).join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
