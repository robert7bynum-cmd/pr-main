"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * Native device registration, for the iOS and Android apps.
 *
 * The apps call register_device / unregister_device directly through
 * supabase-js — the RPCs are the contract (docs/api.md). These server actions
 * exist for parity with savePushSubscription() in ./push.ts, so the web app
 * has one place that speaks the same RPCs, and so a test can exercise the
 * path a phone will take without a phone.
 *
 * Both run as the signed-in user, never as the service role: the function
 * takes the profile from auth.uid(), so there is no way to hand it somebody
 * else's id.
 */
export type DevicePlatform = "ios" | "android";

export async function registerDevice(
  platform: DevicePlatform,
  token: string,
  appVersion?: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: "not signed in" };

  const { data, error } = await supabase.rpc("register_device", {
    p_platform: platform,
    p_token: token,
    p_app_version: appVersion?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data as string };
}

/**
 * Forget a device on sign-out. `removed: false` is a real answer, not a
 * failure: the token was not this person's, or was already gone.
 */
export async function unregisterDevice(
  token: string,
): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: "not signed in" };

  const { data, error } = await supabase.rpc("unregister_device", { p_token: token });
  if (error) return { ok: false, error: error.message };
  return { ok: true, removed: data === true };
}
