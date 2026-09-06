/**
 * Triage, running inside Supabase.
 *
 * This used to live in the Next app, which meant the core loop of the product
 * depended on the web host being reachable — and on a deployment URL being
 * configured before anything worked at all. Here it sits next to the database,
 * has a stable address from the moment the project exists, and keeps running if
 * the web app is down.
 *
 * The keyword rules are not duplicated here either: they live in the database
 * and the matcher is the SQL function match_keywords, which the local test
 * suite exercises too. One implementation, one rule table, no drift.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

type Category =
  | "pace_of_play" | "course_maintenance" | "cart_issue" | "pro_shop" | "f_and_b"
  | "restroom_facilities" | "practice_facility" | "safety" | "caddie_valet" | "needs_review";
type Urgency = "low" | "normal" | "high" | "urgent";

const CATEGORIES: Category[] = [
  "pace_of_play", "course_maintenance", "cart_issue", "pro_shop", "f_and_b",
  "restroom_facilities", "practice_facility", "safety", "caddie_valet", "needs_review",
];

const SYSTEM = `You triage issues reported by members at a private golf club.

Classify the report into exactly one category:
- pace_of_play: slow groups, waiting, backups, needing a marshal
- course_maintenance: turf, bunkers, irrigation, cart paths, trees, tee/course equipment
- cart_issue: a golf cart that won't start, is damaged, or has a dead battery
- pro_shop: merchandise, tee times, scorecards, pin sheets, club storage
- f_and_b: beverage cart, halfway house, restaurant, food or drink orders
- restroom_facilities: on-course or clubhouse restrooms, supplies, plumbing
- practice_facility: driving range, putting green, range balls, mats
- safety: injury, illness, lightning, animals, being hit by a ball, anything hazardous
- caddie_valet: caddies, bag drop, valet, starter
- needs_review: you genuinely cannot tell what is being reported

Urgency: urgent only for a real safety or injury situation. high for something
blocking play or worsening quickly. normal for most things. low for cosmetic
or minor items.

A member describing their own aches, soreness, or a bad round is not a safety
report. Only classify as safety when someone needs help or is in danger.
Complaints about another group's behaviour are pace_of_play or needs_review,
not safety, unless someone is being endangered.

Prefer needs_review over a confident guess. A misrouted report wastes a
crew member's trip; an unclear one simply gets a human's attention.
Set confidence below 0.6 when the report is ambiguous.

The summary is one short line for a staff member's phone. No pleasantries.`;

interface Classification {
  category: Category;
  urgency: Urgency;
  summary: string;
  confidence: number;
  source: "keyword" | "model";
}

async function classifyWithModel(apiKey: string, body: string): Promise<Classification> {
  const text = body.trim();
  if (text.length < 3) {
    return { category: "needs_review", urgency: "normal", summary: "Empty report", confidence: 0, source: "model" };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      system: SYSTEM,
      tools: [{
        name: "classify_report",
        description: "Record the classification of a member's report.",
        strict: true,
        input_schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: { type: "string", enum: CATEGORIES },
            urgency: { type: "string", enum: ["low", "normal", "high", "urgent"] },
            summary: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["category", "urgency", "summary", "confidence"],
        },
      }],
      tool_choice: { type: "tool", name: "classify_report" },
      // Truncated: a pasted essay should not be able to run up the bill.
      messages: [{ role: "user", content: text.slice(0, 1200) }],
    }),
  });

  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 160)}`);

  const json = await res.json();
  const block = json.content?.find((b: { type: string }) => b.type === "tool_use");
  if (!block) {
    return { category: "needs_review", urgency: "normal", summary: text.slice(0, 80), confidence: 0, source: "model" };
  }
  const out = block.input as Classification;
  return {
    category: out.confidence < 0.6 ? "needs_review" : out.category,
    urgency: out.urgency,
    summary: out.summary,
    confidence: out.confidence,
    source: "model",
  };
}

Deno.serve(async (req: Request) => {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Prefer a real platform secret; fall back to the settings row so the system
  // works before anyone has run the CLI.
  let apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) {
    const { data } = await db.from("app_settings").select("value").eq("key", "anthropic_api_key").maybeSingle();
    apiKey = data?.value ?? "";
  }

  const result = {
    claimed: 0, routed: 0, skipped: 0, failed: 0, unstaffed: 0,
    pushSent: 0, pushFailed: 0, pushRetried: 0, pushPruned: 0,
  };

  const { data: batch, error } = await db.rpc("claim_triage_batch", { p_limit: 10 });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }

  for (const item of (batch ?? []) as { report_id: string; body: string }[]) {
    result.claimed++;
    try {
      // Free pass first: most reports never reach the model.
      const { data: kwRows } = await db.rpc("match_keywords", { p_text: item.body });
      const kw = (kwRows as { category: Category; urgency: Urgency; confidence: number }[] | null)?.[0] ?? null;

      const c: Classification = kw
        ? { category: kw.category, urgency: kw.urgency, summary: item.body.slice(0, 80), confidence: Number(kw.confidence), source: "keyword" }
        : apiKey
          ? await classifyWithModel(apiKey, item.body)
          // No key configured: a human decides rather than the report vanishing.
          : { category: "needs_review", urgency: "normal", summary: item.body.slice(0, 80), confidence: 0, source: "model" };

      const { data, error: routeError } = await db.rpc("route_report", {
        p_report_id: item.report_id,
        p_category: c.category,
        p_urgency: c.urgency,
        p_summary: c.summary,
        p_confidence: c.confidence,
        p_source: c.source,
      });
      if (routeError) throw new Error(routeError.message);

      const row = (data as { reason: string }[] | null)?.[0];
      // Both are "nothing to do here", and neither reached anybody. Counting
      // already_closed as routed would be the worker reporting success for
      // work it did not do — the exact failure the skipped counter exists for.
      if (row?.reason === "already_triaged" || row?.reason === "already_closed") {
        await db.rpc("complete_triage", { p_report_id: item.report_id });
        result.skipped++;
      } else {
        result.routed++;
        if (row?.reason === "unstaffed_all_leadership") result.unstaffed++;
      }
    } catch (err) {
      result.failed++;
      await db.rpc("fail_triage", {
        p_report_id: item.report_id,
        p_error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Delivery lives here too, so one invocation carries a report all the way
  // from filed to somebody's phone. Splitting it across two runtimes is how the
  // duplicate matcher happened.
  const push = await deliverQueuedPush(db);
  result.pushSent = push.sent;
  result.pushFailed = push.failed;
  result.pushRetried = push.retried;
  result.pushPruned = push.pruned;

  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  });
});

/**
 * Web push for anything routing just queued.
 *
 * Dead endpoints are pruned on 404/410, and a notification with no subscribed
 * device is marked failed rather than left queued — a stuck queue would let a
 * club believe staff were told when they were not.
 *
 * Any other delivery error is transient until proven otherwise. The first
 * version marked the row failed on the first such error, so one 5xx from the
 * push service lost the page permanently while the row said, truthfully, that
 * it had failed — nobody revisits a failure. The row now stays `queued` with
 * `attempt` bumped and `next_retry_at` set (1, 2, 4 minutes), and is picked up
 * again once due. After MAX_ATTEMPTS it is failed for real, with the last
 * error on it.
 *
 * Two things about how a retry gets picked up, because neither is obvious:
 *
 * - The retry UPDATE does not wake this function. kick_triage is an AFTER
 *   INSERT statement trigger on notifications (20260906040000); an update to
 *   attempt/next_retry_at fires nothing, on purpose — waking the worker at the
 *   moment it has just decided to wait would defeat the backoff.
 * - The retry is delivered by the cron sweep, and the cron gate
 *   (20260906090000) fires only when a queued notification is *due*
 *   (`next_retry_at is null or next_retry_at <= now()`). Under the previous
 *   gate — "any row is queued" — a row waiting out its backoff would have
 *   called this function every minute to do nothing. The select below asks the
 *   gate's exact question so the two cannot disagree about what is due.
 */
const MAX_ATTEMPTS = 3;

async function deliverQueuedPush(db: ReturnType<typeof createClient>) {
  const out = { sent: 0, failed: 0, retried: 0, pruned: 0 };

  const [{ data: pubRow }, { data: privRow }, { data: subjRow }] = await Promise.all([
    db.from("app_settings").select("value").eq("key", "vapid_public_key").maybeSingle(),
    db.from("app_settings").select("value").eq("key", "vapid_private_key").maybeSingle(),
    db.from("app_settings").select("value").eq("key", "vapid_subject").maybeSingle(),
  ]);
  const pub = Deno.env.get("VAPID_PUBLIC_KEY") ?? pubRow?.value;
  const priv = Deno.env.get("VAPID_PRIVATE_KEY") ?? privRow?.value;
  if (!pub || !priv) return out;
  webpush.setVapidDetails(subjRow?.value ?? "mailto:ops@example.com", pub, priv);

  // Queued and due: a row inside its retry backoff is left alone. Same
  // predicate as the cron gate, deliberately.
  const { data: queued } = await db
    .from("notifications").select("id, report_id, profile_id, attempt")
    .eq("channel", "push").eq("status", "queued")
    .or("next_retry_at.is.null,next_retry_at.lte." + new Date().toISOString())
    .limit(50);
  if (!queued?.length) return out;

  for (const n of queued as { id: string; report_id: string; profile_id: string; attempt: number }[]) {
    const { data: report } = await db
      .from("reports").select("id, body, urgency, location_id")
      .eq("id", n.report_id).maybeSingle();

    if (!report) {
      await db.from("notifications").update({
        status: "failed", failed_at: new Date().toISOString(), error: "report not found",
      }).eq("id", n.id);
      out.failed++;
      continue;
    }

    const { data: subs } = await db
      .from("push_subscriptions").select("id, endpoint, p256dh, auth")
      .eq("profile_id", n.profile_id);

    if (!subs?.length) {
      await db.from("notifications").update({
        status: "failed", failed_at: new Date().toISOString(), error: "no push subscription",
      }).eq("id", n.id);
      out.failed++;
      continue;
    }

    const { data: loc } = await db
      .from("locations").select("name, hole_number").eq("id", report.location_id).maybeSingle();
    const where = loc?.hole_number ? `Hole ${loc.hole_number}` : (loc?.name ?? "The course");

    const payload = JSON.stringify({
      title: report.urgency === "urgent" ? `Urgent · ${where}` : where,
      body: String(report.body).slice(0, 120),
      url: `/app/report/${report.id}`,
      urgency: report.urgency,
      tag: report.id,
    });

    let delivered = false;
    let prunedHere = 0;
    let lastError = "";
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        delivered = true;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // The device is gone. Not a retry: this endpoint will never answer.
          await db.from("push_subscriptions").delete().eq("id", sub.id);
          out.pruned++;
          prunedHere++;
        } else {
          lastError = status
            ? `push service ${status}: ${(err as Error).message ?? ""}`.trim()
            : (err instanceof Error ? err.message : String(err));
        }
      }
    }

    if (delivered) {
      await db.from("notifications").update({
        status: "sent", sent_at: new Date().toISOString(),
      }).eq("id", n.id);
      out.sent++;
      continue;
    }

    // Every endpoint this person had was just pruned: there is nothing left to
    // retry against, so this is the same "no push subscription" failure as
    // above, reached one step later.
    if (prunedHere === subs.length) {
      await db.from("notifications").update({
        status: "failed", failed_at: new Date().toISOString(), error: "no push subscription",
      }).eq("id", n.id);
      out.failed++;
      continue;
    }

    const attempt = Number(n.attempt ?? 0);
    if (attempt < MAX_ATTEMPTS) {
      // Still 'queued'. Backoff doubles per attempt: 1, 2, 4 minutes.
      const delayMinutes = 2 ** attempt;
      await db.from("notifications").update({
        attempt: attempt + 1,
        next_retry_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
        error: lastError || "all endpoints failed",
      }).eq("id", n.id);
      out.retried++;
      continue;
    }

    await db.from("notifications").update({
      status: "failed",
      failed_at: new Date().toISOString(),
      error: `${lastError || "all endpoints failed"} (after ${attempt} retries)`,
    }).eq("id", n.id);
    out.failed++;
  }

  return out;
}
