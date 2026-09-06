"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { callbackUrl } from "@/lib/auth/callback-url";

/**
 * Staff sign-in.
 *
 * Password only, and the account is created by an admin — staff never sign
 * themselves up. There is no magic-link fallback on purpose: fewer ways in
 * means fewer ways in.
 */
export interface SignInResult {
  ok: boolean;
  error?: string;
  mustChangePassword?: boolean;
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  // Deliberately vague: a distinct "no such account" message would let anyone
  // enumerate which addresses belong to a club's staff.
  if (error || !data.user) {
    return { ok: false, error: "That email and password don't match." };
  }

  // Links this auth user to the profile their manager created. Someone with
  // valid credentials but no invitation still gets nothing.
  await supabase.rpc("claim_profile");

  if (data.user.user_metadata?.must_change_password) {
    return { ok: true, mustChangePassword: true };
  }
  return { ok: true };
}

/**
 * After an emailed link has become a session in the browser.
 *
 * Password sign-in claims the invited profile inside signIn(); a person who
 * arrived by link never went through signIn, so the same step is done here.
 * Without it the session is valid and the club knows nothing about them.
 */
export async function claimAfterEmailLink(): Promise<SignInResult> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { ok: false, error: "That link has expired. Ask your manager for a new one." };
  await supabase.rpc("claim_profile");
  return { ok: true, mustChangePassword: Boolean(data.user.user_metadata?.must_change_password) };
}

export async function changePassword(next: string): Promise<SignInResult> {
  if (next.length < 10) {
    return { ok: false, error: "Use at least 10 characters." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    password: next,
    data: { must_change_password: false },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * A locked-out staff member asks for a way back in, on their own.
 *
 * Until now the login page said "ask your manager", and the manager's button
 * sent exactly this email. The person can send it themselves: the same
 * rate-limited public endpoint, the same /auth/callback landing that already
 * handles a recovery link, the same /account/password page at the end.
 *
 * The reply never says whether the address exists. Signed-out and not-invited
 * are indistinguishable from outside so nobody can enumerate a club's staff
 * (CLAUDE.md, CC6) — and a "no such account" here would undo that on the one
 * page everyone can reach. Supabase itself answers 200 for an unknown address;
 * if a project setting ever changes that, the branch below keeps the promise.
 */
export async function requestPasswordReset(
  email: string,
): Promise<{ ok: boolean; message: string }> {
  const address = email.trim().toLowerCase();
  if (!address.includes("@")) {
    return { ok: false, message: "Enter the email your club uses for you." };
  }

  const sent = "If that address is on staff here, a sign-in link is on its way.";

  // No session is involved: on the login page there is nothing to be signed
  // in as, and this endpoint is the public, rate-limited one either way.
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(address, {
    redirectTo: await callbackUrl("/account/password"),
  });

  if (!error) return { ok: true, message: sent };

  if (/not found|no user|does not exist/i.test(error.message)) {
    return { ok: true, message: sent };
  }
  if (/after \d+ seconds|rate limit|too many/i.test(error.message)) {
    // The same limit sendPasswordLink in app/actions/staff.ts explains to a
    // manager: roughly one email a minute per address. A staff member has no
    // second button to be pointed at, so the advice is to wait.
    return {
      ok: false,
      message:
        "That was sent moments ago — the mail service allows one a minute. " +
        "Check your inbox, then try again if nothing arrives.",
    };
  }
  return {
    ok: false,
    message: "The link could not be sent just now. Try again in a minute, or ask your manager.",
  };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
