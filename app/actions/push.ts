"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * The VAPID public key, read from the database rather than baked into the bundle.
 *
 * This used to come from NEXT_PUBLIC_VAPID_PUBLIC_KEY, which meant the same key
 * had to be right in two places — app_settings for the worker that sends, and a
 * Vercel build variable for the browser that subscribes. It was wrong in the
 * second place twice: once defined as an empty string, which silently shadowed
 * the perfectly good key underneath, and once simply missing, which failed the
 * build and blocked an unrelated deploy for two hours.
 *
 * A VAPID public key is not a secret — it ships to every browser by design, and
 * only the private half can sign. So there is nothing to protect by inlining it
 * at build time, and one place for it to live is strictly better than two: a
 * club that rotates its keys updates a row, and the next person to subscribe
 * gets the new one without a redeploy.
 *
 * The environment variable still wins if it is set, so an operator can override
 * without touching the database. `|| undefined` rather than `??`, because an
 * empty string is not a key — that distinction is the whole bug.
 */
export async function getPushPublicKey(): Promise<string | null> {
  const fromEnv = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()
    || process.env.VAPID_PUBLIC_KEY?.trim()
    || undefined;
  if (fromEnv) return fromEnv;

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("app_settings").select("value").eq("key", "vapid_public_key").maybeSingle();
  if (error) return null;
  return data?.value?.trim() || null;
}

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

  // Marked as a test. The row borrows a real report to hang on, and without
  // this that report's record claimed the club had told someone about it —
  // which is the accountability data this product is sold on, inflated by a
  // button press. Delivery still goes through the ordinary path; only the
  // bookkeeping distinguishes it.
  await admin.from("notifications").insert({
    report_id: recent[0].id,
    course_id: recent[0].course_id,
    profile_id: data.user.id,
    channel: "push",
    status: "queued",
    is_test: true,
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
