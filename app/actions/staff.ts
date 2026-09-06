"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export interface StaffResult { ok: boolean; message?: string; link?: string }

/**
 * Where an emailed link should bring someone back to.
 *
 * The origin the manager is on right now, which for invitations is the right
 * answer: they are on the club's real site when they press the button. The
 * link only works if this origin is on the Supabase project's redirect
 * allow-list; otherwise Supabase quietly sends the person to its configured
 * Site URL instead, which on a fresh project is localhost — the reason the
 * first invitations ever sent from this app would have gone nowhere.
 */
async function callbackUrl(next: string): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("host") ?? "localhost:3000";
  return `${proto}://${host}/auth/callback?next=${encodeURIComponent(next)}`;
}

/**
 * Every one of these calls a SECURITY DEFINER function that enforces the
 * privilege rules itself. Nothing here decides who may do what — that check
 * lives beside the data, so a different client cannot skip it.
 */
async function call(fn: string, args: Record<string, unknown>): Promise<StaffResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/app/staff");
  return { ok: true };
}

export async function inviteStaff(
  email: string, fullName: string, role: string, departmentIds: string[],
): Promise<StaffResult> {
  if (!email.includes("@")) return { ok: false, message: "Enter a valid email." };
  if (!fullName.trim()) return { ok: false, message: "Enter their name." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("invite_staff", {
    p_email: email.trim().toLowerCase(),
    p_full_name: fullName.trim(),
    p_role: role,
    p_department_ids: departmentIds,
    p_phone: null,
  });
  if (error) return { ok: false, message: error.message };

  // The invitation itself is an email from Supabase with a one-time link. It
  // lands on /auth/callback, which turns the link into a session, links that
  // session to the profile the manager just created, and sends the person to
  // choose a password. No temporary password is shown on screen any more —
  // the earlier flow did that, and every manager who used it expected an email
  // to have gone out and was surprised when nothing arrived.
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const address = email.trim().toLowerCase();

  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(address, {
    data: { must_change_password: true },
    redirectTo: await callbackUrl("/account/password"),
  });

  revalidatePath("/app/staff");

  if (inviteError && /already been registered|already exists/i.test(inviteError.message)) {
    // They have a login from before. The invitation still stands; what they
    // need is a way in, which is the same email a password reset sends.
    const sent = await sendPasswordLink(address);
    return sent.ok
      ? { ok: true, message: `${address} already had a login — sent them a sign-in link instead.` }
      : sent;
  }
  if (inviteError) {
    return { ok: false, message: `Invitation could not be emailed: ${inviteError.message}` };
  }
  return { ok: true, message: `Invitation emailed to ${address}. It lasts 24 hours.` };
}

/**
 * A sign-in link on our own domain, for a manager to hand over directly.
 *
 * Supabase's own email link goes through its /verify endpoint, which redirects
 * to the project's Site URL and drops the path — so a person invited today
 * lands on a bare root instead of the page where they choose a password. That
 * is a dashboard setting, and a club should not be unable to add staff because
 * of one.
 *
 * generateLink mints the token without sending anything; the URL below is ours,
 * and /auth/callback exchanges the token with verifyOtp. Nothing of Supabase's
 * routing is involved, so this works regardless of how the project is
 * configured — and it sidesteps email deliverability entirely, which for a
 * club whose staff are on aol.com and yahoo.com addresses is not a small thing.
 *
 * The link is single-use and short-lived. It is returned to the manager who
 * asked for it and never stored.
 */
export async function createSignInLink(email: string): Promise<StaffResult> {
  const supabase = await createClient();
  const { data: me } = await supabase.rpc("me");
  const actor = Array.isArray(me) ? me[0] : me;
  if (!actor || !["manager", "owner"].includes(actor.role)) {
    return { ok: false, message: "You do not manage staff at this club." };
  }

  const address = email.trim().toLowerCase();
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: address,
  });
  if (error || !data.properties?.hashed_token) {
    return { ok: false, message: error?.message ?? "Could not create a link." };
  }

  const base = (await callbackUrl("/account/password")).split("?")[0];
  const link =
    `${base}?token_hash=${encodeURIComponent(data.properties.hashed_token)}` +
    `&type=recovery&next=${encodeURIComponent("/account/password")}`;

  return { ok: true, link, message: `Link for ${address} — send it to them directly.` };
}

/**
 * A "reset your password" email, which is also how an existing account gets
 * its first sign-in link. Sent with the public client on purpose: this is the
 * ordinary, rate-limited path a person could trigger for themselves from a
 * login page, not an admin action that mints credentials.
 */
async function sendPasswordLink(address: string): Promise<StaffResult> {
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(address, {
    redirectTo: await callbackUrl("/account/password"),
  });

  if (error) {
    // Supabase rate-limits its email endpoint to roughly one message a minute
    // per address. Passing that through verbatim leaves a manager staring at
    // "you can only request this after 32 seconds" with nothing to do — when
    // the button beside it has no such limit and is the better option anyway.
    if (/after \d+ seconds|rate limit|too many/i.test(error.message)) {
      return {
        ok: false,
        message:
          "That was sent moments ago — the mail service allows one a minute. " +
          "Use \u201cGet a sign-in link\u201d instead; it works straight away and " +
          "you can send it however you like.",
      };
    }
    return { ok: false, message: `Could not email a link: ${error.message}` };
  }

  return {
    ok: true,
    message:
      `Emailed to ${address}. If it has not arrived in a few minutes, ` +
      "use \u201cGet a sign-in link\u201d and send it directly.",
  };
}

// Declared as async functions: Next requires every export from a "use server"
// module to be one, and an arrow returning a promise does not qualify.
export async function setActive(id: string, active: boolean): Promise<StaffResult> {
  return call("set_staff_active", { p_profile_id: id, p_active: active });
}

export async function setRole(id: string, role: string): Promise<StaffResult> {
  return call("set_staff_role", { p_profile_id: id, p_role: role });
}

export async function setDepartments(id: string, departmentIds: string[]): Promise<StaffResult> {
  return call("set_staff_departments", { p_profile_id: id, p_department_ids: departmentIds });
}

/** Email someone a link to set a new password. Used when they are locked out. */
export async function resetPassword(id: string, email: string): Promise<StaffResult> {
  const supabase = await createClient();
  const { data: me } = await supabase.rpc("me");
  const actor = Array.isArray(me) ? me[0] : me;
  if (!actor || !["manager", "owner"].includes(actor.role)) {
    return { ok: false, message: "You do not manage staff at this club." };
  }
  const sent = await sendPasswordLink(email.trim().toLowerCase());
  revalidatePath("/app/staff");
  return sent;
}
