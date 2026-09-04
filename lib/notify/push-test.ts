import "server-only";

import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";

export async function sendTestToProfile(profileId: string) {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return { ok: false, error: "push is not configured" };
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:ops@example.com", pub, priv);

  const db = createAdminClient();
  const { data: subs } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("profile_id", profileId);

  if (!subs?.length) return { ok: false, error: "this device is not subscribed yet" };

  let delivered = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({
          title: "ProResponse alerts are working",
          body: "This is what a new report will look like.",
          url: "/app",
          tag: "test",
        }),
      );
      delivered++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await db.from("push_subscriptions").delete().eq("id", sub.id);
    }
  }
  return delivered ? { ok: true } : { ok: false, error: "the browser rejected the notification" };
}
