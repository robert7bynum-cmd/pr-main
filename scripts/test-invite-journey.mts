/**
 * One manager, one invitation, one person signed in — the whole way through,
 * for real.
 *
 * The hole this exists for was closed in 20260906060000_invite_scoping.sql: a
 * manager could call create_staff_invite with the OWNER's email, and the token
 * that came back redeemed into an owner session. That fix is proven offline at
 * the SQL-function layer. This suite proves it where a person would meet it:
 * the manager signs in with the publishable key, asks for the link the button
 * on /app/staff asks for, and the token is redeemed exactly as redeemInvite()
 * in app/actions/staff.ts redeems it — admin redeem, admin generateLink, a
 * fresh anonymous client exchanging the hashed token. The assertion that
 * matters is that the session which results answers `me()` with the invited
 * person's own profile, and nobody else's.
 *
 * It runs against the real project and brings its own staff (a manager to
 * invite, a line staff member to be invited). staff_invites rows do not
 * cascade from the accounts — course_id cascades from courses only, and
 * created_by is `on delete set null` — so this suite removes them itself
 * before the people go. Nothing it creates outlives it.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { provisionTestStaff } from "@/lib/dev/test-staff";
config({ path: ".env.local" });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!URL_ || !PUB || !SVC) {
  console.log("NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing from .env.local");
  process.exit(2);
}

const admin = createClient(URL_, SVC, { auth: { persistSession: false } });
const fixtures = await provisionTestStaff(admin);
const stamp = Date.now().toString(36);

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`);
};
const step = (n: number, title: string) => console.log(`\n${n}. ${title}`);
const note = (s: string) => console.log(`      ${s}`);

const anonClient = () => createClient(URL_, PUB, { auth: { persistSession: false } });

// Everything this run could have minted was minted by the fixture manager, and
// the one that should exist is for a probe-% address. Both are removed: the
// second pattern is what matters, the first is so that a FAILED refusal (an
// owner or stranger row that should never have been written) does not outlive
// the suite that found it. The count says what was actually there.
let fixtureOwnerId: string | null = null;
const finish = async () => {
  let removed = 0;
  for (const q of [
    admin.from("staff_invites").delete().eq("created_by", fixtures.manager.id).select("token"),
    admin.from("staff_invites").delete().like("email", "probe-%@proresponse.test").select("token"),
  ]) {
    const { data: gone, error: delErr } = await q;
    if (delErr) console.log(`\n  !! could not remove staff_invites: ${delErr.message}`);
    removed += gone?.length ?? 0;
  }
  console.log(`\n  removed ${removed} staff_invites row(s)`);
  if (fixtureOwnerId) {
    // Deleting the auth user cascades the profile, as it does for the fixtures.
    const { error } = await admin.auth.admin.deleteUser(fixtureOwnerId);
    if (error) { console.log(`  !! could not remove the stand-in owner: ${error.message}`); fail++; }
    else console.log(`  removed the stand-in owner`);
  }
  await fixtures.teardown();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

// ---------------------------------------------------------- 1. the manager
step(1, "a manager signs in with the key that ships in the browser");
const manager = anonClient();
const { error: inErr } = await manager.auth.signInWithPassword({
  email: fixtures.manager.email, password: fixtures.password,
});
check("the manager can sign in", !inErr, inErr?.message ?? "");
if (inErr) await finish();

// ------------------------------------------------- 2. a link for their staff
step(2, "they ask for a sign-in link for one of their own staff");
const { data: token, error: mintErr } = await manager.rpc("create_staff_invite", {
  p_email: fixtures.staff.email,
});
check("a token comes back", !mintErr && typeof token === "string" && token.length > 0,
  mintErr?.message ?? `got ${JSON.stringify(token)}`);
note(`token length ${typeof token === "string" ? token.length : 0}`);

// ---------------------------------------------------- 3. not for the owner
step(3, "and for the owner — which is not theirs to give");
// The real owner if the club has one. On the day this was written it did not —
// three managers, no owner — and a suite that fails on a fact about the club
// rather than a defect would just be switched off. So when there is no owner,
// one is stood up for this run at the fixtures' course, under the same probe-
// prefix and removed in finish(). The guard being tested does not care which:
// assert_can_manage('owner') refuses a manager either way.
const { data: ownerRows, error: ownerErr } = await admin.from("profiles")
  .select("id, email").eq("role", "owner").eq("active", true).not("email", "is", null).limit(1);
if (ownerErr) console.log(`  !! could not look up the owner: ${ownerErr.message}`);
let owner = (ownerRows ?? [])[0] as { id: string; email: string } | undefined;
if (owner) {
  note("attempting against the club's real owner");
} else {
  const email = `probe-owner-${stamp}@proresponse.test`;
  const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (cErr || !created.user) {
    check("a stand-in owner could be created for this run", false, cErr?.message ?? "no user");
  } else {
    fixtureOwnerId = created.user.id;
    const { error: pErr } = await admin.from("profiles").insert({
      id: fixtureOwnerId, course_id: fixtures.courseId, full_name: "Test Owner (automated)",
      email, role: "owner", active: true, on_duty: false,
    });
    check("a stand-in owner could be created for this run", !pErr, pErr?.message ?? "");
    if (!pErr) owner = { id: fixtureOwnerId, email };
    note("the club has no owner — attempting against a stand-in created for this run");
  }
}
if (owner?.email) {
  const { data: ownerToken, error: ownerMintErr } = await manager.rpc("create_staff_invite", {
    p_email: owner.email,
  });
  check("a manager is refused a link for the owner", Boolean(ownerMintErr) && !ownerToken,
    `ACCEPTED — a manager can mint an owner session (${JSON.stringify(ownerToken)})`);
  note(`refused with: ${ownerMintErr?.message ?? "(no error)"}`);
  // The refusal must not have left an invitation behind for the owner's address.
  const { data: ownerInvites } = await admin.from("staff_invites")
    .select("token").ilike("email", owner.email).is("used_at", null)
    .gt("created_at", new Date(Date.now() - 60_000).toISOString());
  check("and no live invitation for the owner was written", (ownerInvites?.length ?? 0) === 0,
    `${ownerInvites?.length} row(s)`);
}

// ------------------------------------------------ 4. not for a stranger
step(4, "nor for an address at no club at all");
const nobody = `nobody-${stamp}@proresponse.test`;
const { data: nobodyToken, error: nobodyErr } = await manager.rpc("create_staff_invite", {
  p_email: nobody,
});
check("a stranger's address is refused", Boolean(nobodyErr) && !nobodyToken,
  `ACCEPTED — got ${JSON.stringify(nobodyToken)}`);
check("with the one message that reveals nothing about who exists",
  /that person is not at your club/i.test(nobodyErr?.message ?? ""),
  nobodyErr?.message ?? "(no error)");

await manager.auth.signOut();
if (typeof token !== "string" || !token) {
  note("no token to redeem — the rest of the journey cannot run");
  await finish();
}
const inviteToken = token as string;

// ------------------------------------------------- 5. the person presses it
step(5, "the invited person presses the button on /join");
// Exactly what redeemInvite() does: spend our token, mint Supabase's inside
// the same call, and hand the hashed token to a browser that has no session.
const { data: redeemedEmail, error: redeemErr } = await admin.rpc("redeem_staff_invite", {
  p_token: inviteToken,
});
check("the invitation redeems to an email", !redeemErr && typeof redeemedEmail === "string",
  redeemErr?.message ?? "");
check("and it is the invited person's address",
  String(redeemedEmail).toLowerCase() === fixtures.staff.email.toLowerCase(),
  `${redeemedEmail} != ${fixtures.staff.email}`);

const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
  type: "recovery", email: String(redeemedEmail),
});
const tokenHash = link?.properties?.hashed_token;
check("a one-time Supabase token is minted for that address", !linkErr && Boolean(tokenHash),
  linkErr?.message ?? "no hashed_token");

// ------------------------------------------------- 6. who they now are
step(6, "and the browser that exchanges it is signed in as THEM");
const joined = anonClient();
const { data: verified, error: verifyErr } = await joined.auth.verifyOtp({
  token_hash: String(tokenHash), type: "recovery",
});
check("the token exchanges for a session", !verifyErr && Boolean(verified?.session),
  verifyErr?.message ?? "no session");
check("the session's user is the invited account",
  verified?.user?.id === fixtures.staff.id, `${verified?.user?.id} != ${fixtures.staff.id}`);

const { data: meRows, error: meErr } = await joined.rpc("me");
const me = (meRows as { profile_id: string; role: string; full_name: string }[] | null)?.[0];
// This is the assertion the suite exists for. Everything upstream could be
// right and this wrong — the token redeemed, a session issued — and the person
// holding the phone would be somebody else at the club.
check("me() resolves to the invited person's own profile",
  !meErr && me?.profile_id === fixtures.staff.id,
  meErr?.message ?? `${me?.profile_id} != ${fixtures.staff.id}`);
check("with the role the club gave them, not a grander one", me?.role === "staff", String(me?.role));
note(`signed in as ${me?.full_name ?? "(nobody)"} / ${me?.role ?? "-"}`);
await joined.auth.signOut();

// ------------------------------------------------- 7. it was single-use
step(7, "the same link cannot be used again");
const { data: again, error: againErr } = await admin.rpc("redeem_staff_invite", {
  p_token: inviteToken,
});
check("a second redeem is refused", Boolean(againErr) && !again,
  `ACCEPTED — redeemed twice as ${JSON.stringify(again)}`);

const { data: peekRows, error: peekErr } = await admin.rpc("peek_staff_invite", {
  p_token: inviteToken,
});
const peek = (peekRows as { email: string; valid: boolean }[] | null)?.[0];
check("and the landing page would now say so", !peekErr && peek?.valid === false,
  peekErr?.message ?? `valid=${JSON.stringify(peek?.valid)}`);

// ------------------------------------------ 8. locked out, and back in alone
step(8, "a locked-out person gets back in on their own");
// requestPasswordReset() in app/actions/auth.ts makes this exact call with the
// publishable key. The email itself cannot be read here, so the link it would
// carry is minted the way redeemInvite() mints one — a recovery link from the
// admin API — and exchanged the way /auth/callback exchanges it. What matters
// is the end: the session belongs to the person who asked.
//
// The supervisor, not the staff member: step 5 minted a recovery token for
// the staff address seconds ago, and Supabase allows one per address per
// minute — asking again is refused as "you can only request this after 59
// seconds", which is the limit working, not the reset failing.
const lockedOut = fixtures.supervisor;
const locked = anonClient();
const { error: askErr } = await locked.auth.resetPasswordForEmail(lockedOut.email);
// The fixtures live at proresponse.test, a reserved TLD nothing can deliver
// to, and Supabase checks deliverability before it sends — but only once it
// has found the account, so the refusal it gives here is "Email address is
// invalid": about the domain, and silent on whether anyone is registered
// there. A staff member's real address passes that check and gets a 200, the
// same 200 an unknown address gets. What is asserted is that the reply, either
// way, says nothing about the account.
const revealing = /not found|no user|does not exist|not registered|unknown/i;
// Supabase's built-in mailer also caps emails per hour project-wide, and the
// accounts suite sends invitations minutes before this runs. "email rate limit
// exceeded" is the cap working, and it names no account either.
const silentEnough = (m: string) => (/invalid|rate limit|too many/i.test(m)) && !revealing.test(m);
check("asking for a reset link says nothing about whether the account exists",
  !askErr || silentEnough(askErr.message),
  askErr?.message ?? "");
note(askErr
  ? `Supabase: "${askErr.message}" — the .test address is undeliverable; the account is not mentioned`
  : "accepted");

const { error: strangerErr } = await locked.auth.resetPasswordForEmail(nobody);
check("and asking for one at an address on no staff list looks exactly the same",
  !strangerErr || silentEnough(strangerErr.message),
  `an outsider can tell who works here: ${strangerErr?.message}`);

const { data: recovery, error: recoveryErr } = await admin.auth.admin.generateLink({
  type: "recovery", email: lockedOut.email,
});
const recoveryHash = recovery?.properties?.hashed_token;
check("the link the email would carry can be minted", !recoveryErr && Boolean(recoveryHash),
  recoveryErr?.message ?? "no hashed_token");

const back = anonClient();
const { data: backIn, error: backErr } = await back.auth.verifyOtp({
  token_hash: String(recoveryHash), type: "recovery",
});
check("it signs the browser in", !backErr && Boolean(backIn?.session), backErr?.message ?? "no session");
const { data: backRows, error: backMeErr } = await back.rpc("me");
const backMe = (backRows as { profile_id: string; role: string }[] | null)?.[0];
check("as the locked-out person's own profile",
  !backMeErr && backMe?.profile_id === lockedOut.id,
  backMeErr?.message ?? `${backMe?.profile_id} != ${lockedOut.id}`);
check("with their own role", backMe?.role === lockedOut.role, String(backMe?.role));
await back.auth.signOut();

await finish();
