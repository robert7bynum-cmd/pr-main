"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface AccountResult { ok: boolean; message?: string }

/**
 * A person's own details.
 *
 * Writes straight to the row rather than through a function, which is safe for
 * exactly one reason: `authenticated` holds UPDATE on four columns of profiles
 * and no others (20260906030000). Adding a field here that is not in that grant
 * fails at the database rather than quietly succeeding, which is the intended
 * behaviour — the grant is the specification, not this file.
 */
export async function updateMyProfile(
  fullName: string,
  phone: string,
): Promise<AccountResult> {
  const name = fullName.trim();
  if (name.length < 2) return { ok: false, message: "Enter your name." };

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, message: "Not signed in." };

  const { error } = await supabase
    .from("profiles")
    .update({ full_name: name, phone: phone.trim() || null })
    .eq("id", auth.user.id);

  if (error) return { ok: false, message: error.message };
  revalidatePath("/account");
  revalidatePath("/app");
  return { ok: true, message: "Saved." };
}

/**
 * Going on or off duty.
 *
 * Through set_my_duty rather than the column grant, because the function also
 * stamps on_duty_since — which is deliberately NOT grantable. A person setting
 * their own "on duty since" is how duty-time reporting becomes fiction.
 */
export async function setMyDuty(onDuty: boolean): Promise<AccountResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_my_duty", { p_on_duty: onDuty });
  if (error) return { ok: false, message: error.message };
  revalidatePath("/account");
  revalidatePath("/app");
  return {
    ok: true,
    message: onDuty ? "You are on duty." : "You are off duty.",
  };
}
