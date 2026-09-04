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

  // Delivery lives in the Supabase function; queue a notification and let the
  // same code path that handles real alerts deliver it. Testing a different
  // path would prove nothing about the one that matters.
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  const { data: recent } = await admin
    .from("reports").select("id, course_id")
    .order("created_at", { ascending: false }).limit(1);
  if (!recent?.length) return { ok: false, error: "no reports to test with yet" };

  await admin.from("notifications").insert({
    report_id: recent[0].id,
    course_id: recent[0].course_id,
    profile_id: data.user.id,
    channel: "push",
    status: "queued",
  });

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/triage`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  if (!res.ok) return { ok: false, error: "could not reach the alert service" };

  const out = (await res.json()) as { pushSent?: number };
  return out.pushSent
    ? { ok: true }
    : { ok: false, error: "this device is not subscribed, or the browser rejected it" };
}
