/**
 * Can a manager actually create a working login for someone?
 *
 * This is the question that decides whether one-click demo sign-in can be
 * turned off. Every piece of it existed and none of it had been run end to end
 * against the real project: the privilege guard on invite_staff, the auth user
 * created alongside the profile, the temporary password handed to the manager,
 * the forced change on first use, and the claim that links the login to the
 * invitation.
 *
 * Creates a throwaway account and removes it again, so it is safe to re-run.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { provisionTestStaff } from "@/lib/dev/test-staff";
config({ path: ".env.local" });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// The manager doing the inviting is created for this run and removed after.
// The club has no demo personas any more, and a suite that needs one brings
// its own.
const admin0 = createClient(URL_, SVC, { auth: { persistSession: false } });
const fixtures = await provisionTestStaff(admin0);
const MANAGER = fixtures.manager.email;
const MANAGER_PW = fixtures.password;

const stamp = Date.now();
const EMAIL = `probe-invitee-${stamp}@proresponse.test`;
const TEMP = `Tmp-${stamp}-aA1`;
const NEXT_PW = `Chosen-${stamp}-bB2`;

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };
const admin = createClient(URL_, SVC, { auth: { persistSession: false } });

let createdUserId: string | null = null;
try {
  // 1. A manager invites, through the same guarded RPC the console calls.
  const mgr = createClient(URL_, PUB, { auth: { persistSession: false } });
  const { error: mgrErr } = await mgr.auth.signInWithPassword({ email: MANAGER, password: MANAGER_PW });
  check("a manager can sign in", !mgrErr, mgrErr?.message ?? "");

  const { data: depts } = await mgr.from("departments").select("id").limit(1);
  const deptIds = (depts ?? []).map((d: { id: string }) => d.id);

  const { error: inviteErr } = await mgr.rpc("invite_staff", {
    p_email: EMAIL, p_full_name: "Probe Account", p_role: "staff",
    p_department_ids: deptIds, p_phone: null,
  });
  check("the manager may invite staff", !inviteErr, inviteErr?.message ?? "");

  // 2. The auth account, created with the service key exactly as the server
  //    action does, carrying the flag that forces a password change.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: EMAIL, password: TEMP, email_confirm: true,
    user_metadata: { must_change_password: true },
  });
  createdUserId = created?.user?.id ?? null;
  check("an auth login is created for them", !createErr && Boolean(createdUserId), createErr?.message ?? "");

  // 3. They sign in with the temporary password they were handed.
  const staff = createClient(URL_, PUB, { auth: { persistSession: false } });
  const { data: firstIn, error: firstErr } =
    await staff.auth.signInWithPassword({ email: EMAIL, password: TEMP });
  check("they can sign in with the temporary password", !firstErr, firstErr?.message ?? "");
  check("and are told they must change it",
    firstIn?.user?.user_metadata?.must_change_password === true,
    JSON.stringify(firstIn?.user?.user_metadata ?? {}));

  // 4. claim_profile is what links the login to the invitation. Without it a
  //    valid password still gets you nothing, which is the intended behaviour
  //    for someone who was never invited.
  const { error: claimErr } = await staff.rpc("claim_profile");
  check("claiming links the login to the invited profile", !claimErr, claimErr?.message ?? "");
  const { data: me } = await staff.rpc("me");
  const profile = (me as { course_id?: string }[] | null)?.[0];
  check("they resolve to a profile at the club", Boolean(profile?.course_id),
    JSON.stringify(me));

  // 5. Changing the password clears the flag and actually takes effect.
  const { error: changeErr } = await staff.auth.updateUser({
    password: NEXT_PW, data: { must_change_password: false },
  });
  check("they can set their own password", !changeErr, changeErr?.message ?? "");
  await staff.auth.signOut();

  const again = createClient(URL_, PUB, { auth: { persistSession: false } });
  const { data: secondIn, error: secondErr } =
    await again.auth.signInWithPassword({ email: EMAIL, password: NEXT_PW });
  check("the new password works", !secondErr, secondErr?.message ?? "");
  check("and they are no longer forced to change it",
    secondIn?.user?.user_metadata?.must_change_password === false,
    JSON.stringify(secondIn?.user?.user_metadata ?? {}));

  const stale = createClient(URL_, PUB, { auth: { persistSession: false } });
  const { error: staleErr } = await stale.auth.signInWithPassword({ email: EMAIL, password: TEMP });
  check("the temporary password stops working", Boolean(staleErr), "old password still accepted");
  await again.auth.signOut();
} finally {
  // Remove the probe whatever happened, so this never leaves an account behind.
  //
  // The invitee's own claim writes an admin_events row naming them as actor,
  // and that reference does not cascade — on purpose, an audit trail pointing
  // at nobody is worthless. It also means deleteUser fails on the foreign key
  // unless those rows go first, which is exactly how one probe account was
  // left in production with the cleanup line above it looking correct.
  if (createdUserId) {
    await admin.from("admin_events").delete()
      .or(`actor_id.eq.${createdUserId},subject_id.eq.${createdUserId}`);
    const { error: delErr } = await admin.auth.admin.deleteUser(createdUserId);
    // Loud, not swallowed: a leftover account is the thing this block exists to prevent.
    if (delErr) { console.log(`  !! could not remove ${EMAIL}: ${delErr.message}`); fail++; }
  }
  await admin.from("pending_profiles").delete().eq("email", EMAIL);
  await admin.from("profiles").delete().eq("id", createdUserId ?? "00000000-0000-0000-0000-000000000000");
  await fixtures.teardown();
  console.log(`\n  (cleaned up ${EMAIL} and the fixture staff)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
