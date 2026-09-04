"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";

export interface StaffResult { ok: boolean; message?: string; tempPassword?: string }

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

  // The auth account needs the service key, which the RPC deliberately does not
  // have. Created here, with a temporary password they must replace.
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const temp = randomBytes(9).toString("base64url");

  const { error: authError } = await admin.auth.admin.createUser({
    email: email.trim().toLowerCase(),
    password: temp,
    email_confirm: true,
    user_metadata: { must_change_password: true },
  });

  revalidatePath("/app/staff");

  // Already registered is not a failure: the invitation still stands, they just
  // keep their existing password.
  if (authError && !/already been registered/i.test(authError.message)) {
    return { ok: false, message: authError.message };
  }
  if (authError) return { ok: true, message: "Invited. They keep their existing password." };

  return { ok: true, tempPassword: temp };
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

/** Issue a new temporary password. Used when someone is locked out. */
export async function resetPassword(id: string, email: string): Promise<StaffResult> {
  const supabase = await createClient();
  const { data: me } = await supabase.rpc("me");
  const actor = Array.isArray(me) ? me[0] : me;
  if (!actor || !["manager", "owner"].includes(actor.role)) {
    return { ok: false, message: "You do not manage staff at this club." };
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const temp = randomBytes(9).toString("base64url");

  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users.users.find((u) => u.email === email);
  if (!user) return { ok: false, message: "No sign-in account for that address yet." };

  const { error } = await admin.auth.admin.updateUserById(user.id, {
    password: temp,
    user_metadata: { must_change_password: true },
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/app/staff");
  return { ok: true, tempPassword: temp };
}
