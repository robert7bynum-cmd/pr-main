"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
