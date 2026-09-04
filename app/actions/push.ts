"use server";

import { createClient } from "@/lib/supabase/server";

/** Store a browser's push subscription against the signed-in staff member. */
export async function savePushSubscription(sub: {
  endpoint: string;
  p256dh: string;
  auth: string;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { ok: false, error: "not signed in" };

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      profile_id: data.user.id,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      failure_count: 0,
    },
    { onConflict: "endpoint" },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Send a test notification to this device.
 *
 * Onboarding is not complete until a real notification has demonstrably
 * arrived — an unverified alert path is the same as no alerts, and it fails
 * silently until the day it matters.
 */
export async function sendTestPush(): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { ok: false, error: "not signed in" };

  const { sendTestToProfile } = await import("@/lib/notify/push-test");
  return sendTestToProfile(data.user.id);
}
