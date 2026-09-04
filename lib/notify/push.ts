import "server-only";

import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Web push delivery.
 *
 * Endpoints expire, phones are off, browsers drop subscriptions. Every send is
 * recorded and a dead subscription is pruned on the spot — a stale endpoint
 * that keeps failing silently is how a club ends up believing staff were
 * notified when they were not.
 */
let configured = false;
function configure() {
  if (configured) return true;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:ops@example.com", pub, priv);
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  urgency?: string;
  tag?: string;
}

export interface PushResult {
  sent: number;
  failed: number;
  pruned: number;
}

/** Deliver every queued notification that has a push subscription. */
export async function deliverQueuedPush(limit = 50): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, pruned: 0 };
  if (!configure()) return result;

  const db = createAdminClient();

  const { data: queued } = await db
    .from("notifications")
    .select("id, report_id, profile_id, course_id")
    .eq("channel", "push")
    .eq("status", "queued")
    .limit(limit);

  if (!queued?.length) return result;

  // Fetch the reports once rather than per recipient.
  const reportIds = [...new Set(queued.map((n) => n.report_id))];
  const { data: reports } = await db
    .from("reports")
    .select("id, body, urgency, location_id")
    .in("id", reportIds);
  const { data: locations } = await db
    .from("locations")
    .select("id, name, hole_number");

  const reportById = new Map((reports ?? []).map((r) => [r.id, r]));
  const locById = new Map((locations ?? []).map((l) => [l.id, l]));

  for (const n of queued) {
    const report = reportById.get(n.report_id);

    // Its report is gone or unreadable. Leaving the notification queued would
    // hide the gap forever — the same defect as the worker counting skipped
    // reports as routed. Record the failure so it is countable.
    if (!report) {
      await db.from("notifications").update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error: "report not found",
      }).eq("id", n.id);
      result.failed++;
      continue;
    }

    const { data: subs } = await db
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth, failure_count")
      .eq("profile_id", n.profile_id);

    if (!subs?.length) {
      // Nobody to push to. Mark it failed rather than leaving it queued
      // forever, so the gap is visible instead of silent.
      await db.from("notifications").update({
        status: "failed", failed_at: new Date().toISOString(),
        error: "no push subscription",
      }).eq("id", n.id);
      result.failed++;
      continue;
    }

    const loc = locById.get(report.location_id);
    const where = loc?.hole_number ? `Hole ${loc.hole_number}` : (loc?.name ?? "The course");
    const payload: PushPayload = {
      title: report.urgency === "urgent" ? `Urgent · ${where}` : where,
      body: report.body.slice(0, 120),
      url: `/app/report/${report.id}`,
      urgency: report.urgency,
      tag: report.id,
    };

    let delivered = false;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        );
        delivered = true;
        await db.from("push_subscriptions")
          .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
          .eq("id", sub.id);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410 mean the browser threw the subscription away. Keeping it
        // would inflate the failure count forever and hide real problems.
        if (status === 404 || status === 410) {
          await db.from("push_subscriptions").delete().eq("id", sub.id);
          result.pruned++;
        } else {
          // A transient failure. Count it so a chronically failing device
          // can be surfaced to its owner for re-enrolment.
          await db
            .from("push_subscriptions")
            .update({ failure_count: (sub as { failure_count?: number }).failure_count ?? 0 + 1 })
            .eq("id", sub.id);
        }
      }
    }

    await db.from("notifications").update(
      delivered
        ? { status: "sent", sent_at: new Date().toISOString() }
        : { status: "failed", failed_at: new Date().toISOString(), error: "all endpoints failed" },
    ).eq("id", n.id);

    delivered ? result.sent++ : result.failed++;
  }

  return result;
}
