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

/**
 * invite_staff upserts on (course, email) and overwrites the role. It used to
 * ask assert_can_manage about the NEW role only, so a manager could re-invite
 * a pending owner as 'staff', demote the unclaimed row, and then mint a link
 * for it — create_staff_invite trusts the pending row's role. The guard is now
 * asked about greatest(existing, new), as set_staff_role already was.
 */
console.log("\n10. re-inviting cannot demote a pending owner");
{
  const errorOf = async (sql: string, p: unknown[] = []) => {
    try { await db.query(sql, p); return null; } catch (e) { return (e as Error).message; }
  };
  const incoming = "incoming-owner@beaconhillgolfva.com";
  const owner = (await one<{ id: string }>(
    `select id from profiles where role = 'owner' and active limit 1`))!.id;

  await act(owner);
  await db.query(`select invite_staff($1, 'Incoming Owner', 'owner')`, [incoming]);
  const pending = await one<{ role: string }>(`select role from pending_profiles where email = $1`, [incoming]);
  check("an owner can invite an owner", pending?.role === "owner", String(pending?.role));

  await act(manager);
  const demote = await errorOf(`select invite_staff($1, 'Incoming Owner', 'staff')`, [incoming]);
  check("a manager re-inviting that address as staff is refused", demote !== null, "accepted");
  check("for the owner reason, not a generic one", Boolean(demote?.includes("only an owner")), demote ?? "");
  const still = await one<{ role: string; claimed_at: string | null }>(
    `select role, claimed_at from pending_profiles where email = $1`, [incoming]);
  check("the pending row still says owner", still?.role === "owner", JSON.stringify(still));
  check("and the manager still cannot mint a link for it",
    await throws(`select create_staff_invite($1)`, [incoming]));
  const audited = await one<{ n: number }>(
    `select count(*)::int n from admin_events where type = 'staff_invited' and actor_id = $1
       and detail->>'email' = $2`, [manager, incoming]);
  check("nothing was recorded as invited by the manager", (audited?.n ?? -1) === 0, String(audited?.n));

  // The legitimate case is untouched: a manager may change a pending
  // invitation they are allowed to manage.
  await db.query(`select invite_staff('newhire@beaconhillgolfva.com', 'New Hire', 'supervisor')`);
  const changed = await one<{ role: string }>(
    `select role from pending_profiles where email = 'newhire@beaconhillgolfva.com'`);
  check("a manager can still re-invite pending staff at a role they manage",
    changed?.role === "supervisor", String(changed?.role));
}

/**
 * Club settings, locations, departments and placards.
 *
 * 20260906100000 made these tables read-only for signed-in users and nothing
 * replaced the write path, so a club could not rename a hole or set the address
 * its placards encode without a developer. These are the functions that give
 * it back, and each guard below is a specific way the old table write could be
 * abused: from another club, by staff, with an address that dies on a sign,
 * with a malformed quiet-hours value that would stop the escalation sweep.
 */
console.log("\n11. club settings: staff refused on every function");
{
  const errorOf = async (sql: string, p: unknown[] = []) => {
    try { await db.query(sql, p); return null; } catch (e) { return (e as Error).message; }
  };
  const hole1 = (await one<{ id: string }>(
    `select id from locations where course_id = $1 and hole_number = 1`, [course]))!.id;
  const dept1 = (await one<{ id: string }>(
    `select id from departments where course_id = $1 order by sort_order limit 1`, [course]))!.id;

  await act(staff);
  for (const [name, sql, p] of [
    ["update_course_settings", `select update_course_settings('X Club','America/New_York',null,null,null)`, []],
    ["upsert_location", `select upsert_location(null,'other',null,'Snack Bar',null)`, []],
    ["set_location_active", `select set_location_active($1,false)`, [hole1]],
    ["upsert_department", `select upsert_department(null,'snacks','Snacks',null)`, []],
    ["mint_placard", `select mint_placard($1)`, [hole1]],
  ] as [string, string, unknown[]][]) {
    const err = await errorOf(sql, p);
    check(`a staff member cannot call ${name}`, err !== null && err.includes("do not manage"), err ?? "accepted");
  }
  const staffEvents = await one<{ n: number }>(
    `select count(*)::int n from admin_events where actor_id = $1
       and type in ('settings_changed','location_changed','placard_regenerated')`, [staff]);
  check("and nothing was recorded for any of them", staffEvents?.n === 0, String(staffEvents?.n));

  // A manager at the other club: every id-taking function must refuse an id
  // from Beacon Hill, and the settings call must touch only their own club.
  console.log("\n12. club settings: a manager at another club cannot reach in");
  const otherMgrAuth = (await one<{ id: string }>(
    `insert into auth.users (id, email, aud, role, confirmation_token, recovery_token,
       email_change_token_new, email_change)
     values (gen_random_uuid(),'m@other.com','authenticated','authenticated','','','','')
     returning id`))!.id;
  const otherManager = (await one<{ id: string }>(
    `insert into profiles (id, course_id, full_name, role) values ($1,$2,'Other Manager','manager')
     returning id`, [otherMgrAuth, other]))!.id;
  await act(otherManager);

  const foreignLoc = await errorOf(`select upsert_location($1,'hole',1,'Hole 1 (stolen)',null)`, [hole1]);
  check("upsert_location on another club's location is refused",
    foreignLoc?.includes("not at your club") ?? false, foreignLoc ?? "accepted");
  const foreignRetire = await errorOf(`select set_location_active($1,false)`, [hole1]);
  check("set_location_active on another club's location is refused",
    foreignRetire?.includes("not at your club") ?? false, foreignRetire ?? "accepted");
  const foreignMint = await errorOf(`select mint_placard($1)`, [hole1]);
  check("mint_placard on another club's location is refused",
    foreignMint?.includes("not at your club") ?? false, foreignMint ?? "accepted");
  const foreignDept = await errorOf(`select upsert_department($1,'stolen','Stolen',null)`, [dept1]);
  check("upsert_department on another club's department is refused",
    foreignDept?.includes("not at your club") ?? false, foreignDept ?? "accepted");
  const untouched = await one<{ name: string; active: boolean; codes: number }>(
    `select l.name, l.active, (select count(*)::int from qr_codes q where q.location_id = l.id and q.active) codes
       from locations l where l.id = $1`, [hole1]);
  check("Hole 1 is untouched", untouched?.name === "Hole 1" && untouched?.active === true && untouched?.codes === 1,
    JSON.stringify(untouched));

  await db.query(`select update_course_settings('Other Club Renamed','America/Chicago',null,null,null)`);
  const names = await one<{ mine: string; theirs: string }>(
    `select (select name from courses where id = $1) mine, (select name from courses where id = $2) theirs`,
    [course, other]);
  check("their settings call renames their club only",
    names?.theirs === "Other Club Renamed" && names?.mine === "Beacon Hill Golf Club", JSON.stringify(names));

  console.log("\n13. club settings: what is refused, with the message a manager sees");
  await act(manager);
  const refused = async (label: string, args: string, expect: string) => {
    const err = await errorOf(`select update_course_settings(${args})`);
    check(label, err !== null && err.includes(expect), err ?? "accepted");
  };
  await refused("a timezone Postgres does not know", `'Beacon Hill Golf Club','Mars/Olympus_Mons',null,null,null`, "unknown timezone");
  await refused("an http address", `'Beacon Hill Golf Club','America/New_York','http://beaconhillgolfva.com',null,null`, "must start with https://");
  await refused("localhost", `'Beacon Hill Golf Club','America/New_York','https://localhost:3000',null,null`, "cannot go on a printed sign");
  await refused("127.0.0.1", `'Beacon Hill Golf Club','America/New_York','https://127.0.0.1',null,null`, "cannot go on a printed sign");
  await refused("a Vercel branch preview", `'Beacon Hill Golf Club','America/New_York','https://pr-main-git-feature-scope.vercel.app',null,null`, "cannot go on a printed sign");
  await refused("quiet hours that are not HH:MM", `'Beacon Hill Golf Club','America/New_York',null,'8pm','6am'`, "quiet hours must be HH:MM");
  await refused("an hour of 24", `'Beacon Hill Golf Club','America/New_York',null,'24:00','06:00'`, "quiet hours must be HH:MM");
  await refused("a start with no end", `'Beacon Hill Golf Club','America/New_York',null,'20:00',null`, "both a start and an end");
  await refused("a one-letter club name", `'B','America/New_York',null,null,null`, "between 2 and 80");
  const beforeCount = await one<{ n: number }>(
    `select count(*)::int n from admin_events where course_id = $1 and type = 'settings_changed'`, [course]);
  check("none of those wrote a settings_changed row", beforeCount?.n === 0, String(beforeCount?.n));

  console.log("\n14. club settings: a valid change lands and is recorded");
  const changed = await one<{ n: number }>(
    `select update_course_settings('Beacon Hill Golf Club','America/New_York','https://reports.beaconhill.com/','21:00','06:30') n`);
  check("two keys changed (address and quiet hours)", changed?.n === 2, String(changed?.n));
  const settings = await one<{ settings: Record<string, unknown>; timezone: string }>(
    `select settings, timezone from courses where id = $1`, [course]);
  check("the address is stored without its trailing slash",
    settings?.settings.public_url === "https://reports.beaconhill.com", JSON.stringify(settings?.settings));
  const quiet = settings?.settings.quiet_hours as { start?: string; end?: string } | undefined;
  check("quiet hours are stored as start and end",
    quiet?.start === "21:00" && quiet?.end === "06:30", JSON.stringify(quiet));
  check("branding survived the jsonb edit", "branding" in (settings?.settings ?? {}), JSON.stringify(settings?.settings));
  const ev = await one<{ detail: { kind: string; from: Record<string, unknown>; to: Record<string, unknown> } }>(
    `select detail from admin_events where course_id = $1 and type = 'settings_changed'
      order by created_at desc, id desc limit 1`, [course]);
  check("settings_changed written with kind club", ev?.detail?.kind === "club", JSON.stringify(ev?.detail));
  check("and it names only the keys that changed",
    JSON.stringify(Object.keys(ev?.detail?.to ?? {}).sort()) === JSON.stringify(["public_url", "quiet_hours"]),
    JSON.stringify(ev?.detail));
  check("the old address is in from",
    ev?.detail?.from?.public_url === "https://pr-main-dun.vercel.app", JSON.stringify(ev?.detail?.from));

  const again = await one<{ n: number }>(
    `select update_course_settings('Beacon Hill Golf Club','America/New_York','https://reports.beaconhill.com','21:00','06:30') n`);
  check("saving the same values again reports zero changes", again?.n === 0, String(again?.n));
  const cleared = await one<{ n: number }>(
    `select update_course_settings('Beacon Hill Golf Club','America/New_York',null,null,null) n`);
  const clearedSettings = await one<{ settings: Record<string, unknown> }>(
    `select settings from courses where id = $1`, [course]);
  check("clearing the address and quiet hours removes the keys",
    cleared?.n === 2 && !("public_url" in clearedSettings!.settings) && !("quiet_hours" in clearedSettings!.settings),
    JSON.stringify(clearedSettings?.settings));
  check("with no quiet hours the club is never in quiet hours",
    (await one<{ q: boolean }>(`select within_quiet_hours($1) q`, [course]))!.q === false);
  await db.query(`select update_course_settings('Beacon Hill Golf Club','America/New_York','https://pr-main-dun.vercel.app','20:00','06:00')`);

  console.log("\n15. locations: add, rename, and the friendly duplicate");
  const snack = (await one<{ id: string }>(
    `select upsert_location(null,'other',null,'Snack Bar',null) id`))!.id;
  const snackRow = await one<{ name: string; kind: string; active: boolean; sort_order: number; venue_id: string | null }>(
    `select name, kind::text, active, sort_order, venue_id from locations where id = $1`, [snack]);
  check("a facility is added at this club", snackRow?.name === "Snack Bar" && snackRow?.kind === "other" && snackRow?.active === true,
    JSON.stringify(snackRow));
  check("it sorts after everything already there", (snackRow?.sort_order ?? 0) > 24, String(snackRow?.sort_order));
  check("it belongs to the club's venue", snackRow?.venue_id !== null);
  await db.query(`select upsert_location($1,'halfway_house',null,'Turn Snack Bar',null)`, [snack]);
  const renamed = await one<{ name: string; kind: string }>(`select name, kind::text from locations where id = $1`, [snack]);
  check("and renamed", renamed?.name === "Turn Snack Bar" && renamed?.kind === "halfway_house", JSON.stringify(renamed));
  const locEvents = await one<{ actions: string[] }>(
    `select array_agg(detail->>'action' order by id) actions from admin_events where subject_id = $1 and type = 'location_changed'`, [snack]);
  check("both recorded as location_changed", JSON.stringify(locEvents?.actions) === JSON.stringify(["added", "changed"]),
    JSON.stringify(locEvents?.actions));

  const dup = await errorOf(`select upsert_location(null,'hole',7,'Hole 7 again',null)`);
  check("a duplicate hole number gets the friendly message", dup?.includes("that hole number is already used") ?? false, dup ?? "accepted");
  const dupRename = await errorOf(`select upsert_location($1,'hole',7,'Hole 7',null)`, [snack]);
  check("so does renumbering onto an existing hole", dupRename?.includes("that hole number is already used") ?? false, dupRename ?? "accepted");
  const noNumber = await errorOf(`select upsert_location(null,'hole',null,'Hole ?',null)`);
  check("a hole needs a number", noNumber !== null, "accepted");
  const hole19 = (await one<{ id: string }>(`select upsert_location(null,'hole',19,'Hole 19',null) id`))!.id;
  const h19 = await one<{ sort_order: number; hole_number: number }>(`select sort_order, hole_number from locations where id = $1`, [hole19]);
  check("a new hole sorts by its number", h19?.sort_order === 19 && h19?.hole_number === 19, JSON.stringify(h19));

  console.log("\n16. locations: retiring");
  const busy = (await one<{ location_id: string }>(
    `select location_id from reports where course_id = $1 and status in ('new','triaged','acknowledged','in_progress')
      group by location_id order by count(*) desc limit 1`, [course]))!.location_id;
  const busyRefused = await errorOf(`select set_location_active($1,false)`, [busy]);
  check("a location with open reports cannot be retired",
    busyRefused?.includes("close its open reports first") ?? false, busyRefused ?? "accepted");
  check("it is still active", (await one<{ active: boolean }>(`select active from locations where id = $1`, [busy]))!.active === true);

  await db.query(`select set_location_active($1,false)`, [snack]);
  const retiredRow = await one<{ active: boolean }>(`select active from locations where id = $1`, [snack]);
  check("one with none is retired", retiredRow?.active === false);
  const retiredEv = await one<{ detail: { action: string } }>(
    `select detail from admin_events where subject_id = $1 and type = 'location_changed' order by id desc limit 1`, [snack]);
  check("and location_changed says retired", retiredEv?.detail?.action === "retired", JSON.stringify(retiredEv?.detail));
  const twice = await errorOf(`select set_location_active($1,false)`, [snack]);
  check("retiring it again is reported, not silently accepted", twice?.includes("already retired") ?? false, twice ?? "accepted");
  const mintRetired = await errorOf(`select mint_placard($1)`, [snack]);
  check("no sign can be minted for a retired location", mintRetired !== null, "accepted");

  // A retired hole's existing sign must stop working, whatever its token says.
  const hole18 = (await one<{ id: string; token: string }>(
    `select l.id, q.token from locations l join qr_codes q on q.location_id = l.id and q.active
      where l.course_id = $1 and l.hole_number = 18`, [course]))!;
  await db.query(`update reports set status = 'resolved', resolved_at = now() where location_id = $1
                    and status not in ('resolved','verified','closed_no_action')`, [hole18.id]);
  await db.query(`select set_location_active($1,false)`, [hole18.id]);
  const scanRetired = await db.query(`select * from get_scan_context($1)`, [hole18.token]);
  check("get_scan_context refuses a retired location's code", scanRetired.rows.length === 0, String(scanRetired.rows.length));
  await db.query(`select set_location_active($1,true)`, [hole18.id]);
  const scanRestored = await db.query(`select * from get_scan_context($1)`, [hole18.token]);
  check("and resolves it again once restored", scanRestored.rows.length === 1, String(scanRestored.rows.length));
  const restoredEv = await one<{ detail: { action: string } }>(
    `select detail from admin_events where subject_id = $1 and type = 'location_changed' order by id desc limit 1`, [hole18.id]);
  check("the restore is recorded too", restoredEv?.detail?.action === "restored", JSON.stringify(restoredEv?.detail));

  console.log("\n17. placards: a new code retires the old one");
  const hole7 = (await one<{ id: string; token: string }>(
    `select l.id, q.token from locations l join qr_codes q on q.location_id = l.id and q.active
      where l.course_id = $1 and l.hole_number = 7`, [course]))!;
  const fresh = (await one<{ t: string }>(`select mint_placard($1) t`, [hole7.id]))!.t;
  check("the new token is 24 hex characters", /^[0-9a-f]{24}$/.test(fresh), fresh);
  check("and is not the old one", fresh !== hole7.token);
  const oldRow = await one<{ active: boolean }>(`select active from qr_codes where token = $1`, [hole7.token]);
  check("the old token is retired", oldRow?.active === false);
  const live = await one<{ n: number }>(`select count(*)::int n from qr_codes where location_id = $1 and active`, [hole7.id]);
  check("exactly one live code for the hole", live?.n === 1, String(live?.n));
  const scanNew = await db.query<{ location_name: string }>(`select * from get_scan_context($1)`, [fresh]);
  check("get_scan_context resolves the new code to Hole 7",
    scanNew.rows.length === 1 && scanNew.rows[0].location_name === "Hole 7", JSON.stringify(scanNew.rows));
  const scanOld = await db.query(`select * from get_scan_context($1)`, [hole7.token]);
  check("and not the old one", scanOld.rows.length === 0, String(scanOld.rows.length));
  const mintEv = await one<{ detail: Record<string, unknown> }>(
    `select detail from admin_events where subject_id = $1 and type = 'placard_regenerated' order by id desc limit 1`, [hole7.id]);
  const detailText = JSON.stringify(mintEv?.detail ?? {});
  check("placard_regenerated is written", !!mintEv, "missing");
  check("with the new prefix", mintEv?.detail?.new_prefix === fresh.slice(0, 6), detailText);
  check("with the retired prefix", JSON.stringify(mintEv?.detail?.retired_prefixes) === JSON.stringify([hole7.token.slice(0, 6)]), detailText);
  check("and not the new token in full", !detailText.includes(fresh), detailText);

  // The seed's bh-h07 is six characters, so its prefix IS the token. Mint once
  // more so the retired code is a real 24-hex one and the assertion means
  // something.
  const fresher = (await one<{ t: string }>(`select mint_placard($1) t`, [hole7.id]))!.t;
  const mintEv2 = await one<{ detail: Record<string, unknown> }>(
    `select detail from admin_events where subject_id = $1 and type = 'placard_regenerated' order by id desc limit 1`, [hole7.id]);
  const detailText2 = JSON.stringify(mintEv2?.detail ?? {});
  check("a second mint retires the 24-hex code by prefix only",
    JSON.stringify(mintEv2?.detail?.retired_prefixes) === JSON.stringify([fresh.slice(0, 6)])
      && !detailText2.includes(fresh) && !detailText2.includes(fresher), detailText2);
  check("and the first fresh code no longer resolves",
    (await db.query(`select * from get_scan_context($1)`, [fresh])).rows.length === 0);

  console.log("\n18. departments: add and rename, never delete");
  const valet = (await one<{ id: string }>(`select upsert_department(null,'valet','Valet',null) id`))!.id;
  const valetRow = await one<{ key: string; name: string; sort_order: number }>(
    `select key, name, sort_order from departments where id = $1`, [valet]);
  check("a department is added", valetRow?.key === "valet" && valetRow?.name === "Valet", JSON.stringify(valetRow));
  check("after the existing ones", (valetRow?.sort_order ?? 0) > 7, String(valetRow?.sort_order));
  await db.query(`select upsert_department($1,'valet','Valet & Bag Drop',null)`, [valet]);
  check("and renamed", (await one<{ name: string }>(`select name from departments where id = $1`, [valet]))!.name === "Valet & Bag Drop");
  const deptEvents = await one<{ kinds: string[]; actions: string[] }>(
    `select array_agg(detail->>'kind' order by id) kinds, array_agg(detail->>'action' order by id) actions
       from admin_events where subject_id = $1 and type = 'settings_changed'`, [valet]);
  check("both recorded as settings_changed with kind department",
    JSON.stringify(deptEvents?.kinds) === JSON.stringify(["department", "department"])
      && JSON.stringify(deptEvents?.actions) === JSON.stringify(["added", "changed"]),
    JSON.stringify(deptEvents));
  const badKey = await errorOf(`select upsert_department(null,'Valet 2','Valet 2',null)`);
  check("a key with spaces or capitals is refused", badKey !== null, "accepted");
  const dupKey = await errorOf(`select upsert_department(null,'valet','Another Valet',null)`);
  check("a duplicate key gets the friendly message", dupKey?.includes("already used") ?? false, dupKey ?? "accepted");
  check("there is no delete function for departments", (await one<{ n: number }>(
    `select count(*)::int n from pg_proc where proname like '%department%' and proname like 'delete%'`))!.n === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
