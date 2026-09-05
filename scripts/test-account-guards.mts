/**
 * What a person may change about themselves, against the real project.
 *
 * This exists because of one call that succeeded:
 *
 *   update profiles set role = 'owner' where id = <self>   ->  ALLOWED
 *
 * A line staff member, holding nothing but the publishable key that ships in
 * every browser bundle, could make themselves an owner. Every guard in the
 * system reads `role` to decide what you may do; none of them expected you to
 * be able to write it.
 *
 * It has to be tested here rather than offline: the fault was in grants, the
 * fix is in grants, and the offline harness has no PostgREST to send the call
 * through. This makes the call.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });
import { provisionTestStaff } from "@/lib/dev/test-staff";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

const admin = createClient(URL_, SVC, { auth: { persistSession: false } });
const f = await provisionTestStaff(admin);

try {
  const me = createClient(URL_, PUB, { auth: { persistSession: false } });
  const { error: inErr } = await me.auth.signInWithPassword({ email: f.staff.email, password: f.password });
  check("a line staff member can sign in", !inErr, inErr?.message ?? "");

  const roleNow = async () =>
    (await admin.from("profiles").select("role").eq("id", f.staff.id).single()).data?.role;

  console.log("\nthe columns that decide what you may do");
  for (const [label, patch] of [
    ["role", { role: "owner" }],
    ["active", { active: false }],
    ["course_id", { course_id: "00000000-0000-0000-0000-000000000009" }],
    ["account_kind", { account_kind: "station" }],
  ] as [string, Record<string, unknown>][]) {
    const { error } = await me.from("profiles").update(patch).eq("id", f.staff.id);
    check(`cannot change their own ${label}`, Boolean(error),
      "ACCEPTED — this is a privilege escalation");
  }
  check("and their role is still what the club set", (await roleNow()) === "staff", String(await roleNow()));

  console.log("\nthe columns that are theirs");
  const { error: nameErr } = await me.from("profiles")
    .update({ full_name: "Renamed By Themselves", phone: "555-0100" }).eq("id", f.staff.id);
  check("can change their own name and phone", !nameErr, nameErr?.message ?? "");

  const { error: dutyErr } = await me.rpc("set_my_duty", { p_on_duty: false });
  check("can take themselves off duty", !dutyErr, dutyErr?.message ?? "");
  const off = await admin.from("profiles").select("on_duty, on_duty_since").eq("id", f.staff.id).single();
  check("and the duty clock is cleared, not left running", off.data?.on_duty === false && off.data?.on_duty_since === null,
    JSON.stringify(off.data));
  await me.rpc("set_my_duty", { p_on_duty: true });
  const on = await admin.from("profiles").select("on_duty_since").eq("id", f.staff.id).single();
  check("going on duty stamps when, from the server", Boolean(on.data?.on_duty_since));

  // The stamp is not theirs to write, which is what stops duty-time reporting
  // becoming whatever a person types.
  const { error: stampErr } = await me.from("profiles")
    .update({ on_duty_since: "2020-01-01T00:00:00Z" }).eq("id", f.staff.id);
  check("cannot backdate their own duty clock", Boolean(stampErr), "ACCEPTED");

  console.log("\nand nobody else's row is theirs");
  const { error: otherErr } = await me.from("profiles")
    .update({ full_name: "Hacked" }).eq("id", f.supervisor.id);
  const supName = (await admin.from("profiles").select("full_name").eq("id", f.supervisor.id).single()).data?.full_name;
  check("cannot rename a colleague", Boolean(otherErr) || supName !== "Hacked", "the colleague was renamed");

  const { error: delErr } = await me.from("profiles").delete().eq("id", f.staff.id);
  const stillThere = (await admin.from("profiles").select("id").eq("id", f.staff.id)).data?.length === 1;
  check("cannot delete their own profile", Boolean(delErr) || stillThere, "the profile was deleted");

  console.log("\noffboarding ends access, it does not just mark it");
  const mgr = createClient(URL_, PUB, { auth: { persistSession: false } });
  await mgr.auth.signInWithPassword({ email: f.manager.email, password: f.password });
  await admin.from("push_subscriptions").insert({
    profile_id: f.staff.id, endpoint: `https://example.test/${Date.now()}`, p256dh: "p", auth: "a",
  });
  const { error: deacErr } = await mgr.rpc("set_staff_active", { p_profile_id: f.staff.id, p_active: false });
  check("a manager can deactivate them", !deacErr, deacErr?.message ?? "");

  const devices = (await admin.from("push_subscriptions").select("id").eq("profile_id", f.staff.id)).data?.length ?? -1;
  check("their devices stop receiving pages", devices === 0, `${devices} still registered`);

  // The session they still hold must be dead, not merely disallowed.
  const { data: stillReads } = await me.from("reports").select("id").limit(1);
  check("the session they still hold can no longer read the club's reports",
    (stillReads?.length ?? 0) === 0, `${stillReads?.length} reports still readable`);

  const audit = (await admin.from("admin_events").select("type, detail")
    .eq("subject_id", f.staff.id).eq("type", "staff_deactivated").limit(1)).data?.[0] as
    { detail: Record<string, unknown> } | undefined;
  check("and it is written down, with what was revoked", Boolean(audit),
    "no staff_deactivated audit row");
  check("naming the devices removed", Number(audit?.detail?.devices_removed ?? -1) >= 1,
    JSON.stringify(audit?.detail ?? {}));

  await me.auth.signOut();
  await mgr.auth.signOut();
} finally {
  await f.teardown();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
