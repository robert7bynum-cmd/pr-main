import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The external half of the watchdog.
 *
 * Everything this product does on a schedule runs inside Postgres on pg_cron,
 * which is what makes it independent of this web app — and also means that if
 * pg_cron stops, every screen still looks healthy while reports quietly pile up
 * untriaged. The club would find out from an angry member.
 *
 * So the thing that watches the scheduler cannot be the scheduler. This route
 * reads health with the service role and sends push from here directly rather
 * than queueing notifications for the sweep to deliver, because asking a dead
 * process to deliver its own death notice is not monitoring.
 *
 * WHO CALLS IT. vercel.json schedules this once a day, which is the most
 * frequent cron Vercel's Hobby plan allows — a five-minute schedule fails the
 * deployment outright rather than degrading, which is how this shipped broken
 * the first time. Once a day is a floor, not the intended cadence: it catches
 * "dead since yesterday", not "dead for ten minutes".
 *
 * For real coverage point any external pinger at this URL every five minutes.
 * That is also the better architecture, not merely the cheaper one: a Vercel
 * cron cannot report that Vercel is down, and a third party watching from
 * outside both vendors is the only thing that can. On Vercel Pro, changing the
 * schedule in vercel.json to a five-minute expression is the other option.
 *
 * It is deliberately dumb: no retries, no state of its own beyond the alert
 * ledger in the database. If this route breaks, the in-database half still
 * shows the same problems on the dashboard.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface Alert {
  severity: string;
  issue: string;
  detail: string;
}

export async function GET(request: Request) {
  // Vercel Cron sends the project's CRON_SECRET as a bearer token. When the
  // secret is set we require it, so the endpoint cannot be triggered by anyone
  // who guesses the path. When it is not set the route still works — the alert
  // ledger's repeat window is what actually prevents this being useful to
  // someone hammering it, and a watchdog that refuses to run because an
  // optional variable is missing is worse than one anybody can ask the time.
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: "not configured" }, { status: 503 });
  }

  const db = createAdminClient();
  const { data: courses, error: coursesError } = await db.from("courses").select("id, name");
  if (coursesError) {
    return Response.json({ error: coursesError.message }, { status: 503 });
  }

  const vapid = await loadVapid(db);
  const results: Record<string, unknown>[] = [];

  for (const course of courses ?? []) {
    // Records current health, closes out anything that recovered, and returns
    // only what still needs saying — new problems plus standing ones past their
    // repeat window. All of that decided in one statement in the database, so
    // two overlapping cron runs cannot both claim the same alert.
    const { data: alerts, error } = await db.rpc("record_system_alerts", {
      p_course: course.id,
    });

    if (error) {
      results.push({ course: course.name, error: error.message });
      continue;
    }

    const toSend = (alerts ?? []) as Alert[];
    if (!toSend.length) {
      results.push({ course: course.name, healthy: true });
      continue;
    }

    const delivery = vapid
      ? await pushAlerts(db, course.id, toSend, vapid)
      : { sent: 0, recipients: 0, skipped: "push not configured" };

    results.push({
      course: course.name,
      alerts: toSend.map((a) => `${a.severity}: ${a.issue}`),
      ...delivery,
    });
  }

  // An alert that could not be delivered is itself a failure worth surfacing,
  // so this reports what happened rather than always answering 200 OK.
  const degraded = results.some(
    (r) => r.error || (Array.isArray(r.alerts) && r.sent === 0),
  );

  return Response.json(
    { checkedAt: new Date().toISOString(), courses: results },
    { status: degraded ? 503 : 200, headers: { "cache-control": "no-store" } },
  );
}

async function loadVapid(db: ReturnType<typeof createAdminClient>) {
  const [{ data: pub }, { data: priv }, { data: subj }] = await Promise.all([
    db.from("app_settings").select("value").eq("key", "vapid_public_key").maybeSingle(),
    db.from("app_settings").select("value").eq("key", "vapid_private_key").maybeSingle(),
    db.from("app_settings").select("value").eq("key", "vapid_subject").maybeSingle(),
  ]);
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? pub?.value;
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? priv?.value;
  if (!publicKey || !privateKey) return null;
  webpush.setVapidDetails(subj?.value ?? "mailto:ops@proresponse.app", publicKey, privateKey);
  return true;
}

async function pushAlerts(
  db: ReturnType<typeof createAdminClient>,
  courseId: string,
  alerts: Alert[],
  _vapid: true,
) {
  const { data: recipients } = await db.rpc("watchdog_recipients", { p_course: courseId });
  const list = (recipients ?? []) as {
    profile_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }[];

  const worst = alerts.find((a) => a.severity === "critical") ?? alerts[0];
  const payload = JSON.stringify({
    title: worst.severity === "critical" ? `ProResponse: ${worst.issue}` : worst.issue,
    body:
      alerts.length > 1
        ? `${worst.detail} (+${alerts.length - 1} more)`
        : worst.detail,
    url: "/app/settings/health",
    urgency: worst.severity === "critical" ? "urgent" : "normal",
    // One tag for the whole watchdog, so a phone shows the current state of the
    // system rather than a stack of every time it was checked.
    tag: "proresponse-watchdog",
  });

  let sent = 0;
  for (const r of list) {
    try {
      await webpush.sendNotification(
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        payload,
      );
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // A phone that uninstalled or reset stays in the table forever otherwise,
      // and every future check reports a delivery that never happened.
      if (status === 404 || status === 410) {
        await db.from("push_subscriptions").delete().eq("endpoint", r.endpoint);
      }
    }
  }

  return { recipients: list.length, sent };
}
