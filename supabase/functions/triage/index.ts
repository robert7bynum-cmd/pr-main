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

// Bumped whenever SYSTEM changes, and written into ai_raw beside the response,
// so a classification can later be read against the exact instructions that
// produced it rather than whatever the prompt says today.
const PROMPT_VERSION = "2026-09-06";

interface Classification {
  category: Category;
  urgency: Urgency;
  summary: string;
  confidence: number;
  source: "keyword" | "model";
}

const URGENCIES: Urgency[] = ["low", "normal", "high", "urgent"];

/**
 * What the model said, checked before it touches the database.
 *
 * The tool schema asks for these enums, but the schema is a request to the
 * API, not a guarantee from it. An out-of-range value used to be cast straight
 * into route_report, where the Postgres enum cast threw, the item retried five
 * times and dead-lettered — a report nobody saw, because the model said
 * "critical" instead of "urgent". Anything malformed becomes needs_review at
 * confidence 0: a human looks, the report is not lost. The confidence gate
 * (< 0.6 → needs_review, the prompt's own instruction) runs after the shape
 * check so it only ever sees a real number.
 *
 * `rejected` says whether that happened. It is a separate flag rather than
 * something inferred from confidence 0, because a model that honestly answers
 * confidence 0 has not been rejected — it has been believed.
 *
 * Pure and exported so it can be exercised without Deno or a network.
 */
export function validateClassification(
  input: unknown, fallbackSummary: string,
): { c: Classification; rejected: boolean } {
  const reject = () => ({
    c: {
      category: "needs_review" as Category, urgency: "normal" as Urgency,
      summary: fallbackSummary, confidence: 0, source: "model" as const,
    },
    rejected: true,
  });
  if (typeof input !== "object" || input === null) return reject();
  const o = input as Record<string, unknown>;

  const category = o.category;
  if (typeof category !== "string" || !(CATEGORIES as string[]).includes(category)) return reject();
  const urgency = o.urgency;
  if (typeof urgency !== "string" || !(URGENCIES as string[]).includes(urgency)) return reject();
  const confidence = o.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return reject();
  }
  const summary = typeof o.summary === "string" && o.summary.trim() !== "" ? o.summary : fallbackSummary;

  return {
    c: {
      category: confidence < 0.6 ? "needs_review" : (category as Category),
      urgency: urgency as Urgency,
      summary,
      confidence,
      source: "model",
    },
    rejected: false,
  };
}

/**
 * The classification plus what is kept in reports.ai_raw to explain it, and
 * whether the model's answer had to be thrown away to get here.
 */
interface Classified {
  c: Classification;
  raw: Record<string, unknown>;
  rejected: boolean;
}

/**
 * A hung request used to hold the whole claimed batch until the five-minute
 * stale-lock reclaim. Twenty seconds is several times a normal call; past it,
 * this item fails into fail_triage and the rest of the batch proceeds.
 */
const MODEL_TIMEOUT_MS = 20_000;

async function classifyWithModel(apiKey: string, body: string): Promise<Classified> {
  const text = body.trim();
  if (text.length < 3) {
    return {
      c: { category: "needs_review", urgency: "normal", summary: "Empty report", confidence: 0, source: "model" },
      raw: { skipped: "empty report" },
      rejected: false,
    };
  }

  // The timer covers the body as well as the headers. It used to be cleared
  // as soon as fetch() resolved, which is when the headers arrive; a response
  // whose body then stalled was unbounded, and the twenty seconds protected
  // nothing. The body is read inside the same try so one abort covers both.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), MODEL_TIMEOUT_MS);
  let status: number;
  let ok: boolean;
  let bodyText: string;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: abort.signal,
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
              urgency: { type: "string", enum: URGENCIES },
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
    status = res.status;
    ok = res.ok;
    bodyText = await res.text();
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`anthropic timeout after ${MODEL_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!ok) throw new Error(`anthropic ${status}: ${bodyText.slice(0, 160)}`);

  const json = JSON.parse(bodyText);
  // Enough to reconstruct why the model answered as it did, and what it cost;
  // not the whole body, which repeats the request. prompt_version names the
  // SYSTEM text that was in force, since the prompt itself is not stored.
  const raw = {
    prompt_version: PROMPT_VERSION,
    model: json.model,
    stop_reason: json.stop_reason,
    content: json.content,
    usage: json.usage,
  };
  const block = json.content?.find((b: { type: string }) => b.type === "tool_use");
  const fallbackSummary = text.slice(0, 80);
  if (!block) {
    // No tool call at all is the model's answer being unusable, the same as a
    // malformed one: counted as rejected so the run does not read as clean.
    return {
      c: { category: "needs_review", urgency: "normal", summary: fallbackSummary, confidence: 0, source: "model" },
      raw,
      rejected: true,
    };
  }
  const { c, rejected } = validateClassification(block.input, fallbackSummary);
  return { c, raw, rejected };
}

/**
 * A short, non-reversible fingerprint of a key, so a mismatch can be diagnosed
 * from the logs without either key ever being printed.
 */
async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

Deno.serve(async (req: Request) => {
  // Who is calling. The function is deployed with verify_jwt on, and that was
  // taken for authentication — it is not. verify_jwt checks that the bearer is
  // *a* valid JWT signed by this project, and the publishable anon key is
  // exactly that: a valid JWT, shipped in every client bundle. Anyone holding
  // it could POST here and run the worker at will. The only legitimate
  // callers are pg_cron (via pg_net, sending app_settings.service_role_key)
  // and sendTestPush in the Next app (SUPABASE_SERVICE_ROLE_KEY), so the
  // bearer must be the service role key itself — nothing less.
  //
  // Two values count as "the service role key": the one the platform injects
  // into this runtime, and the one the operator stored in app_settings for
  // pg_cron to send. They are the same key today, but this project uses the
  // newer sb_secret_ key format and the injected variable is not guaranteed to
  // be the same string — and a mismatch here would 401 every scheduled run
  // while every screen stayed green. Both are secrets only the service role
  // can read, so accepting either does not widen who may call.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  let storedKey = "";
  if (serviceKey && bearer && bearer !== serviceKey) {
    const probe = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false } });
    const { data } = await probe.from("app_settings").select("value").eq("key", "service_role_key").maybeSingle();
    storedKey = data?.value?.trim() ?? "";
  }
  if (!serviceKey || !bearer || (bearer !== serviceKey && bearer !== storedKey)) {
    // Fingerprints only: enough to tell "cron holds a stale key" from "an
    // anon caller", never enough to recover either.
    console.warn(
      `triage: rejected caller; expected sha256 ${serviceKey ? await fingerprint(serviceKey) : "(unset)"}, ` +
        `got ${bearer ? await fingerprint(bearer) : "(no bearer)"}`,
    );
    return new Response(JSON.stringify({ error: "service role required" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceKey,
    { auth: { persistSession: false } },
  );

  // Prefer a real platform secret; fall back to the settings row so the system
  // works before anyone has run the CLI.
  let apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) {
    const { data } = await db.from("app_settings").select("value").eq("key", "anthropic_api_key").maybeSingle();
    apiKey = data?.value ?? "";
  }

  // modelRejected: the model answered and the answer was thrown away (bad
  // enum, missing tool call). Those reports land in needs_review and are not
  // lost, but a run that discarded model output is not a clean run, and a
  // rising count is the first sign the prompt or the model has changed.
  //
  // native*: the same four questions for FCM/APNs devices, plus nativeSkipped —
  // a device token that could not be tried because neither transport is
  // configured. That is counted rather than swallowed so the body of a run
  // says "there were phones and nothing spoke to them".
  const result = {
    claimed: 0, routed: 0, skipped: 0, failed: 0, unstaffed: 0, aiRawUnsaved: 0, modelRejected: 0,
    pushSent: 0, pushFailed: 0, pushRetried: 0, pushPruned: 0,
    nativeSent: 0, nativeFailed: 0, nativePruned: 0, nativeSkipped: 0,
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
      const kw = (kwRows as { category: Category; urgency: Urgency; confidence: number; matched: string }[] | null)?.[0] ?? null;

      const { c, raw, rejected }: Classified = kw
        ? {
          c: { category: kw.category, urgency: kw.urgency, summary: item.body.slice(0, 80), confidence: Number(kw.confidence), source: "keyword" },
          raw: { matched: kw.matched, confidence: Number(kw.confidence) },
          rejected: false,
        }
        : apiKey
          ? await classifyWithModel(apiKey, item.body)
          // No key configured: a human decides rather than the report vanishing.
          : {
            c: { category: "needs_review", urgency: "normal", summary: item.body.slice(0, 80), confidence: 0, source: "model" },
            raw: { skipped: "no api key configured" },
            rejected: false,
          };
      if (rejected) result.modelRejected++;

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
        // The evidence behind the triaged event: what matched, or what the
        // model actually said. Written only when this classification is the
        // one that routed the report, so ai_raw never describes a decision
        // discarded as already_triaged. The report is routed and its people
        // paged by now, so a failure here is counted and logged, not retried —
        // re-running the item would only find already_triaged.
        const { error: rawError } = await db.from("reports").update({ ai_raw: raw }).eq("id", item.report_id);
        if (rawError) {
          result.aiRawUnsaved++;
          console.error(`triage: ai_raw not saved for ${item.report_id}: ${rawError.message}`);
        }
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
  result.nativeSent = push.nativeSent;
  result.nativeFailed = push.nativeFailed;
  result.nativePruned = push.nativePruned;
  result.nativeSkipped = push.nativeSkipped;

  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  });
});

/**
 * Push for anything routing just queued: web push to browsers, FCM and APNs
 * to phones (see the native section at the bottom of this file).
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
  const out = {
    sent: 0, failed: 0, retried: 0, pruned: 0,
    nativeSent: 0, nativeFailed: 0, nativePruned: 0, nativeSkipped: 0,
  };

  const [{ data: pubRow }, { data: privRow }, { data: subjRow }] = await Promise.all([
    db.from("app_settings").select("value").eq("key", "vapid_public_key").maybeSingle(),
    db.from("app_settings").select("value").eq("key", "vapid_private_key").maybeSingle(),
    db.from("app_settings").select("value").eq("key", "vapid_subject").maybeSingle(),
  ]);
  const pub = Deno.env.get("VAPID_PUBLIC_KEY") ?? pubRow?.value;
  const priv = Deno.env.get("VAPID_PRIVATE_KEY") ?? privRow?.value;
  const webReady = Boolean(pub && priv);
  if (webReady) webpush.setVapidDetails(subjRow?.value ?? "mailto:ops@example.com", pub, priv);

  // The native transports (FCM for Android, APNs for iOS) come from the
  // function's secrets and are optional until the apps exist. A misconfigured
  // secret is logged and treated as absent: every phone it would have reached
  // is then counted under nativeSkipped, so the run says so.
  let native: NativeSenders | null = null;
  try {
    native = await loadNativeSenders();
  } catch (err) {
    console.error(`triage: native push disabled this run: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!webReady && !native) return out;

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

    // Everything this person can be reached on: browser subscriptions and
    // native device tokens. Delivery to any one of them is delivery.
    const [{ data: subRows }, { data: deviceRows }] = await Promise.all([
      db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("profile_id", n.profile_id),
      db.from("device_tokens").select("id, platform, token, failure_count").eq("profile_id", n.profile_id),
    ]);
    const subs = (subRows ?? []) as { id: string; endpoint: string; p256dh: string; auth: string }[];
    const devices = (deviceRows ?? []) as { id: string; platform: "ios" | "android"; token: string; failure_count: number }[];

    if (!subs.length && !devices.length) {
      await db.from("notifications").update({
        status: "failed", failed_at: new Date().toISOString(), error: "no push subscription",
      }).eq("id", n.id);
      out.failed++;
      continue;
    }

    const { data: loc } = await db
      .from("locations").select("name, hole_number").eq("id", report.location_id).maybeSingle();
    const where = loc?.hole_number ? `Hole ${loc.hole_number}` : (loc?.name ?? "The course");

    const note: Note = {
      title: report.urgency === "urgent" ? `Urgent · ${where}` : where,
      body: String(report.body).slice(0, 120),
      url: `/app/report/${report.id}`,
      urgency: String(report.urgency),
      tag: String(report.id),
    };
    const payload = JSON.stringify(note);

    let delivered = false;
    let prunedHere = 0;
    let lastError = "";

    // Web push, as before.
    for (const sub of subs) {
      if (!webReady) {
        // A browser is subscribed and there are no VAPID keys to sign for it.
        // Not silently skipped: the row records why nothing reached it.
        lastError = "web push not configured (no VAPID keys)";
        break;
      }
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

    // Native push. Each platform has its own transport; a device whose
    // transport is not configured is counted, not passed over.
    for (const d of devices) {
      const send = d.platform === "ios" ? native?.apns : native?.fcm;
      if (!send) {
        out.nativeSkipped++;
        lastError = `${d.platform} push not configured`;
        continue;
      }
      const r = await send(d.token, note);
      if (r.outcome === "sent") {
        delivered = true;
        out.nativeSent++;
      } else if (r.outcome === "gone") {
        // The service says this token will never work again. Same as a web
        // 410: delete it, do not retry against it.
        await db.from("device_tokens").delete().eq("id", d.id);
        out.nativePruned++;
        prunedHere++;
      } else {
        await db.from("device_tokens")
          .update({ failure_count: Number(d.failure_count ?? 0) + 1 }).eq("id", d.id);
        out.nativeFailed++;
        lastError = r.error;
      }
    }

    if (delivered) {
      await db.from("notifications").update({
        status: "sent", sent_at: new Date().toISOString(),
      }).eq("id", n.id);
      out.sent++;
      continue;
    }

    // Every device this person had was just pruned: there is nothing left to
    // retry against, so this is the same "no push subscription" failure as
    // above, reached one step later.
    if (prunedHere === subs.length + devices.length) {
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

// ---------------------------------------------------------------------------
// Native push: FCM for Android, APNs for iOS.
//
// Both services authenticate the sender with a JWT the sender signs itself —
// RS256 with a Google service-account key for FCM, ES256 with an Apple .p8 key
// for APNs. The helpers between the JWT-HELPERS markers build those with
// WebCrypto alone, no library, and are deliberately free of anything Deno- or
// Supabase-specific: an offline Node harness copies them verbatim and checks
// the header and claims shape with a throwaway key, which is the only test
// possible without Apple's or Google's servers on the line.
//
// Configuration is entirely from the function's secrets:
//   FCM_SERVICE_ACCOUNT  the service-account JSON, as one string
//   APNS_KEY             the .p8 PEM (a literal "\n" between lines is accepted)
//   APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID
//   APNS_ENV             production (default) or sandbox
// Neither set: no native delivery, and every device that would have been
// tried is counted under nativeSkipped.
// ---------------------------------------------------------------------------

/** What the worker wants a phone to show. The same fields the web payload carries. */
interface Note { title: string; body: string; url: string; urgency: string; tag: string }

/**
 * sent: the service accepted it. gone: the token is dead — delete it, do not
 * retry. failed: transient until proven otherwise; bump failure_count and let
 * the notification's retry schedule decide.
 */
type NativeResult = { outcome: "sent" } | { outcome: "gone" } | { outcome: "failed"; error: string };
type NativeSender = (token: string, note: Note) => Promise<NativeResult>;
interface NativeSenders { fcm?: NativeSender; apns?: NativeSender }

// ---- JWT-HELPERS (copied verbatim into the offline harness; keep self-contained) ----

/** base64url without padding, of bytes or of a UTF-8 string. */
function b64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A PEM private key ("BEGIN PRIVATE KEY", PKCS#8 — what both Google's JSON and
 * Apple's .p8 contain) to the DER bytes WebCrypto imports. A key pasted into a
 * one-line secret arrives with literal backslash-n; that is accepted too.
 */
function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/\\n/g, "\n").replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function importRs256Key(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
}

function importEs256Key(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
}

/**
 * header.claims.signature, compact serialisation. The algorithm follows the
 * key: an ECDSA key signs ES256, an RSA key RS256. WebCrypto's ECDSA output is
 * already the raw r||s that JOSE wants, so no DER unwrapping is needed.
 */
async function signJwt(
  header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey,
): Promise<string> {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const alg = key.algorithm.name === "ECDSA"
    ? { name: "ECDSA", hash: "SHA-256" }
    : { name: "RSASSA-PKCS1-v1_5" };
  const sig = await crypto.subtle.sign(alg, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

/** The assertion Google exchanges for an OAuth2 access token: RS256, one hour. */
function fcmAssertionClaims(clientEmail: string, nowSeconds: number) {
  return {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
}

/** APNs provider token claims: ES256, the team as issuer. Apple honours one for up to an hour. */
function apnsTokenClaims(teamId: string, nowSeconds: number) {
  return { iss: teamId, iat: nowSeconds };
}

// ---- end JWT-HELPERS ----

interface FcmConfig { projectId: string; clientEmail: string; key: CryptoKey }

async function loadFcm(): Promise<FcmConfig | null> {
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT");
  if (!raw) return null;
  const sa = JSON.parse(raw) as { project_id?: string; client_email?: string; private_key?: string };
  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error("FCM_SERVICE_ACCOUNT lacks project_id, client_email or private_key");
  }
  return { projectId: sa.project_id, clientEmail: sa.client_email, key: await importRs256Key(sa.private_key) };
}

/** One access token per invocation: signed assertion in, bearer token out. */
async function fcmAccessToken(cfg: FcmConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt({ alg: "RS256", typ: "JWT" }, fcmAssertionClaims(cfg.clientEmail, now), cfg.key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`google oauth ${res.status}: ${String(body.error_description ?? body.error ?? "").slice(0, 120)}`);
  }
  return body.access_token;
}

/**
 * FCM HTTP v1. `notification` is what the OS shows; `data` is what the app
 * reads when the person taps it. High priority so a locked phone wakes.
 */
async function sendFcm(cfg: FcmConfig, accessToken: string, token: string, note: Note): Promise<NativeResult> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${cfg.projectId}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: note.title, body: note.body },
        data: { url: note.url, urgency: note.urgency, tag: note.tag },
        android: { priority: "high" },
      },
    }),
  });
  if (res.ok) return { outcome: "sent" };
  const text = await res.text();
  // UNREGISTERED is FCM's "this token will never work again"; a 404 from the
  // send endpoint says the same thing about the token.
  if (res.status === 404 || /UNREGISTERED/.test(text)) return { outcome: "gone" };
  return { outcome: "failed", error: `fcm ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 160)}` };
}

interface ApnsConfig { key: CryptoKey; keyId: string; teamId: string; bundleId: string; host: string }

async function loadApns(): Promise<ApnsConfig | null> {
  const pem = Deno.env.get("APNS_KEY");
  if (!pem) return null;
  const keyId = Deno.env.get("APNS_KEY_ID");
  const teamId = Deno.env.get("APNS_TEAM_ID");
  const bundleId = Deno.env.get("APNS_BUNDLE_ID");
  if (!keyId || !teamId || !bundleId) {
    throw new Error("APNS_KEY is set but APNS_KEY_ID, APNS_TEAM_ID or APNS_BUNDLE_ID is not");
  }
  const env = Deno.env.get("APNS_ENV") ?? "production";
  if (env !== "production" && env !== "sandbox") {
    throw new Error(`APNS_ENV must be production or sandbox, not "${env}"`);
  }
  return {
    key: await importEs256Key(pem), keyId, teamId, bundleId,
    host: env === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com",
  };
}

/** One provider token per invocation. */
function apnsProviderToken(cfg: ApnsConfig): Promise<string> {
  return signJwt({ alg: "ES256", kid: cfg.keyId }, apnsTokenClaims(cfg.teamId, Math.floor(Date.now() / 1000)), cfg.key);
}

/**
 * APNs over HTTP/2, which Deno's fetch negotiates on its own. An urgent report
 * is time-sensitive so it breaks through a Focus mode; everything else is an
 * ordinary alert. `url` and `tag` ride beside `aps` for the app to read.
 */
async function sendApns(cfg: ApnsConfig, providerToken: string, token: string, note: Note): Promise<NativeResult> {
  const res = await fetch(`${cfg.host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${providerToken}`,
      "apns-topic": cfg.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: {
        alert: { title: note.title, body: note.body },
        sound: "default",
        "interruption-level": note.urgency === "urgent" ? "time-sensitive" : "active",
      },
      url: note.url,
      tag: note.tag,
    }),
  });
  if (res.ok) return { outcome: "sent" };
  const text = await res.text();
  let reason = "";
  try { reason = String((JSON.parse(text) as { reason?: string }).reason ?? ""); } catch { /* not JSON */ }
  // 410 is "the device token is no longer active for the topic"; BadDeviceToken
  // and Unregistered are the reasons that mean the same at other statuses.
  if (res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") return { outcome: "gone" };
  return { outcome: "failed", error: `apns ${res.status}${reason ? " " + reason : ""}` };
}

/**
 * The per-platform senders for this invocation, or null when neither is
 * configured. Each mints its bearer once and reuses it for every device in
 * the run; a minting failure surfaces as a failed delivery on the device that
 * needed it, and the next device tries afresh.
 */
async function loadNativeSenders(): Promise<NativeSenders | null> {
  const [fcm, apns] = await Promise.all([loadFcm(), loadApns()]);
  if (!fcm && !apns) return null;
  const senders: NativeSenders = {};
  const failed = (err: unknown): NativeResult => ({
    outcome: "failed", error: err instanceof Error ? err.message : String(err),
  });
  if (fcm) {
    let accessToken: Promise<string> | null = null;
    senders.fcm = async (token, note) => {
      try {
        accessToken ??= fcmAccessToken(fcm);
        return await sendFcm(fcm, await accessToken, token, note);
      } catch (err) {
        accessToken = null;
        return failed(err);
      }
    };
  }
  if (apns) {
    let providerToken: Promise<string> | null = null;
    senders.apns = async (token, note) => {
      try {
        providerToken ??= apnsProviderToken(apns);
        return await sendApns(apns, await providerToken, token, note);
      } catch (err) {
        providerToken = null;
        return failed(err);
      }
    };
  }
  return senders;
}
