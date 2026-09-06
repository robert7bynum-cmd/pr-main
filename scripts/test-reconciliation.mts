/**
 * Reconciliation against the real production database. READ-ONLY.
 *
 * Every other test in this repo runs against a throwaway Postgres or a
 * disposable fixture. None of them prove the actual ~250 reports sitting in
 * the real club's database are internally consistent — that every number a
 * GM sees on a dashboard is traceable to the event that produced it, and that
 * nobody was quietly dropped.
 *
 * "Every metric derives from report_events, never from a mutable column"
 * (CLAUDE.md, Processing integrity) is a promise about the past, not just the
 * schema. This is the harness that checks the promise was kept for data that
 * already exists, not for a fixture built to make it easy.
 *
 * This script performs SELECT only. It never inserts, updates, or deletes a
 * row. If you are tempted to add a fix-up query here, don't — this is a
 * verifier, and a verifier that repairs what it finds can no longer be
 * trusted to report what it found.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!URL_ || !SVC) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const sb = createClient(URL_, SVC, { auth: { persistSession: false } });

// PostgREST caps a single response at 1000 rows by default. report_events
// alone is well past that, so every table is paged rather than trusting one
// call to return everything — a silent truncation here would make this
// script itself guilty of exactly the failure it exists to catch.
async function fetchAll<T>(table: string, columns: string): Promise<T[]> {
  const page = 1000;
  let from = 0;
  const out: T[] = [];
  for (;;) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + page - 1);
    if (error) throw new Error(`fetching ${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < page) break;
    from += page;
  }
  return out;
}

let pass = 0, fail = 0;
function check(name: string, violations: string[], total: number) {
  const ok = violations.length === 0;
  ok ? pass++ : fail++;
  const suffix = total ? ` (${total} checked)` : "";
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${suffix}`);
  if (!ok) {
    const shown = violations.slice(0, 10);
    console.log(`        offending: ${shown.join(", ")}${violations.length > 10 ? ` … and ${violations.length - 10} more` : ""}`);
  }
}

type Report = {
  id: string; course_id: string; location_id: string; status: string;
  department_id: string | null; created_at: string;
};
type ReportEvent = {
  id: number; report_id: string; course_id: string; type: string;
  payload: Record<string, unknown>; created_at: string;
};
type Notification = {
  id: string; report_id: string; course_id: string; profile_id: string | null;
  status: string; created_at: string;
  /** A "send a test" alert. Delivered for real, but told nobody about the report. */
  is_test: boolean;
};
type Profile = { id: string; course_id: string; active: boolean };
type Location = { id: string; course_id: string };

console.log("loading real data from production (read-only)…\n");

const [reports, events, notifications, profiles, locations] = await Promise.all([
  fetchAll<Report>("reports", "id,course_id,location_id,status,department_id,created_at"),
  fetchAll<ReportEvent>("report_events", "id,report_id,course_id,type,payload,created_at"),
  fetchAll<Notification>("notifications", "id,report_id,course_id,profile_id,status,created_at,is_test"),
  fetchAll<Profile>("profiles", "id,course_id,active"),
  fetchAll<Location>("locations", "id,course_id"),
]);

const reportById = new Map(reports.map(r => [r.id, r]));
const profileById = new Map(profiles.map(p => [p.id, p]));
const locationById = new Map(locations.map(l => [l.id, l]));
const routedEvents = events.filter(e => e.type === "routed");
const routedByReport = new Map<string, ReportEvent[]>();
for (const e of routedEvents) {
  const list = routedByReport.get(e.report_id) ?? [];
  list.push(e);
  routedByReport.set(e.report_id, list);
}
// A "send a test" alert borrows a real report to hang on. It is delivered
// through the ordinary path on purpose, but it never told anyone about that
// report, so counting it here would report a club as having notified people it
// did not.
const notificationsByReport = new Map<string, Notification[]>();
for (const n of notifications.filter(n => !n.is_test)) {
  const list = notificationsByReport.get(n.report_id) ?? [];
  list.push(n);
  notificationsByReport.set(n.report_id, list);
}

/**
 * `recipients` out of a routed event's JSON payload, or undefined.
 *
 * The payload is whatever was written to the database, so its shape is
 * genuinely unknown at the type level — but that is a reason to check it, not
 * to cast it away. Whether this returns a number is itself the signal that
 * separates an event route_report() wrote from one the seed hand-built.
 */
const recipientsIn = (payload: unknown): number | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const v = (payload as Record<string, unknown>).recipients;
  return typeof v === "number" ? v : undefined;
};

const nonNew = reports.filter(r => r.status !== "new");

// --------------------------------------------------------------- populations
//
// Two populations share this table, and judging them by one standard makes
// this harness useless as a go-live gate — it fails forever on history nobody
// intends to change, so people stop reading it.
//
//   backfill — rows written by supabase/seed.sql and scripts/freshen-demo.mts
//              to make the demo look like a working club. Their events were
//              hand-built and do not match what route_report() emits: the
//              seed's `routed` payload carries only department_id, and the
//              freshener used to mark reports resolved with no event at all.
//   live     — everything filed since, which is the application actually
//              running. Held to every invariant below without exception.
//
// The split is by time, taken from the data rather than hardcoded: the last
// backfilled report is the boundary. The backfill is NOT excused — it is
// counted, named and printed, so a quiet run can never be mistaken for a clean
// one. What it is not is a permanent red light on work already done.
const isSeedShaped = (id: string) => {
  const evs = routedByReport.get(id) ?? [];
  return evs.length > 0 && evs.every(e => recipientsIn(e.payload) === undefined);
};
const backfillCutoff = reports
  .filter(r => isSeedShaped(r.id))
  .reduce((max, r) => (r.created_at > max ? r.created_at : max), "");
const isLive = (r: { created_at: string }) => backfillCutoff === "" || r.created_at > backfillCutoff;
const liveNonNew = nonNew.filter(isLive);
const legacyNonNew = nonNew.filter(r => !isLive(r));

console.log(`  ${liveNonNew.length} reports filed by the running application; ` +
  `${legacyNonNew.length} seeded or demo-generated before ${backfillCutoff.slice(0, 19) || "n/a"}\n`);

console.log("routing and delivery\n");

// route_report() raises rather than commits a routing that reached nobody
// (supabase/migrations/20260905000000_no_silent_success.sql) — but that fix
// only guards the code path going forward. This is the check that the
// invariant actually held for every report that exists, not just the ones
// filed since the fix landed.
// A report can legitimately be closed before triage catches up — somebody
// standing there fixes it within the minute. That is the product working
// unusually well, and the closing event now records it explicitly, so a fast
// fix and a report that went missing are never the same shape.
const closedEarly = new Set(
  events
    .filter(e => (e.payload as Record<string, unknown> | null)?.closed_before_routing === true)
    .map(e => e.report_id),
);
check(
  "every report past 'new' was either routed or recorded as closed before routing",
  liveNonNew
    .filter(r => !(routedByReport.get(r.id)?.length) && !closedEarly.has(r.id))
    .map(r => r.id),
  liveNonNew.length,
);

// "A routing that reached nobody must not look like a success." If this ever
// fires, a report was marked delivered while nobody was actually told.
check(
  "no routed event claims zero recipients",
  routedEvents.filter(e => recipientsIn(e.payload) === 0).map(e => e.report_id),
  routedEvents.length,
);

// The event's `recipients` count and the notifications table are two
// independent records written by the same route_report() call describing the
// same fact. They should agree exactly. (A later escalation can add more
// notifications for the same report — that shows up as an 'escalated' event
// and is called out separately below, not silently absorbed into this check.)
{
  // Escalation and handover both queue notifications after routing, on purpose:
  // escalate_reports() pages leadership, assign_report() tells the new owner,
  // and reroute_report() pages the new department. Each writes its own event
  // (escalated / reassigned), so rows beyond the routed count are legitimate
  // exactly when one of those events exists. Test alerts are excluded above.
  const escalatedReports = new Set(
    events.filter(e => e.type === "escalated" || e.type === "reassigned").map(e => e.report_id),
  );
  const violations: string[] = [];
  const liveIds = new Set(liveNonNew.map(r => r.id));
  let live = 0;
  for (const [reportId, evs] of routedByReport) {
    if (!liveIds.has(reportId)) continue;
    live++;
    const actual = (notificationsByReport.get(reportId) ?? []).length;
    for (const ev of evs) {
      const claimed = recipientsIn(ev.payload);
      if (typeof claimed !== "number") {
        violations.push(`${reportId} (event ${ev.id}: payload has no numeric recipients field — ${JSON.stringify(ev.payload)})`);
      } else if (claimed !== actual) {
        // Escalation deliberately notifies more people after routing, so the
        // routed event's count is a snapshot, not a running total. Demanding
        // equality here called correct escalations defects — the check was
        // wrong, not the system.
        //
        // The invariant that actually matters is narrower and stronger: no
        // notification exists that no event accounts for. Extra rows are only
        // legitimate when the report escalated, and never fewer than routing
        // claimed, which would mean somebody was told and then unrecorded.
        if (!escalatedReports.has(reportId)) {
          violations.push(`${reportId} (event ${ev.id}: claimed ${claimed}, actual notifications rows ${actual}, never escalated or handed over)`);
        } else if (actual < claimed) {
          violations.push(`${reportId} (event ${ev.id}: claimed ${claimed} but only ${actual} notifications exist — someone was told and then unrecorded)`);
        }
      }
    }
  }
  check("every notification is accounted for by a routing, escalation or handover event", violations, live);
}

// The backfill, stated plainly. Not assertions — these describe history that
// is already written — but printed every run so the debt stays visible and
// nobody discovers it again from scratch six months from now.
console.log("\nseeded and demo-generated history (not application behaviour)\n");
{
  const noRouted = legacyNonNew.filter(r => !(routedByReport.get(r.id)?.length));
  const noDept = legacyNonNew.filter(r => r.department_id === null);
  const oldShape = legacyNonNew.filter(r => isSeedShaped(r.id));
  const line = (n: number, what: string, cause: string) =>
    console.log(`  ${n === 0 ? "none" : String(n).padStart(4)}  ${what}${n ? "  — " + cause : ""}`);
  line(oldShape.length, "routed events carrying no recipients count",
    "supabase/seed.sql hand-builds the event instead of calling route_report()");
  line(noRouted.length, "resolved reports that were never routed",
    "scripts/freshen-demo.mts closed reports still in 'new' (fixed; history not rewritten)");
  line(noDept.length, "reports past 'new' with no department", "same cause");
  console.log("\n  These are demo fixtures, not member reports. The tooling that produced");
  console.log("  them is fixed, so the counts cannot grow; the rows themselves are left");
  console.log("  alone because rewriting history to make a report look routed would be");
  console.log("  the same falsification this harness exists to catch.\n");
}

console.log("\ntriage completeness\n");

check(
  "every report past 'new' has a department assigned",
  liveNonNew.filter(r => r.department_id === null && !closedEarly.has(r.id)).map(r => r.id),
  liveNonNew.length,
);

{
  const stillNew = reports.filter(r => r.status === "new");
  const TEN_MIN = 10 * 60 * 1000;
  const now = Date.now();
  const stuck = stillNew.filter(r => now - new Date(r.created_at).getTime() > TEN_MIN).map(r => r.id);
  check(`no report stuck in 'new' past 10 minutes (${stillNew.length} currently in 'new')`, stuck, stillNew.length);
}

console.log("\ntenant isolation\n");

// A notification that reaches a profile at another club, or a deactivated
// one, is a leak or a message nobody will see — either way it must not exist.
{
  const violations: string[] = [];
  for (const n of notifications) {
    const report = reportById.get(n.report_id);
    const profile = n.profile_id ? profileById.get(n.profile_id) : undefined;
    if (!report) { violations.push(`${n.id} (report ${n.report_id} not found)`); continue; }
    if (!profile) { violations.push(`${n.id} (profile ${n.profile_id} not found)`); continue; }
    if (!profile.active) { violations.push(`${n.id} (profile ${n.profile_id} inactive)`); continue; }
    if (profile.course_id !== report.course_id) {
      violations.push(`${n.id} (profile course ${profile.course_id} != report course ${report.course_id})`);
    }
  }
  check("every notification targets an active, same-club profile", violations, notifications.length);
}

check(
  "every report's location belongs to the report's course",
  reports.filter(r => {
    const loc = locationById.get(r.location_id);
    return !loc || loc.course_id !== r.course_id;
  }).map(r => r.id),
  reports.length,
);

console.log("\ndelivery health\n");

{
  const TEN_MIN = 10 * 60 * 1000;
  const now = Date.now();
  const queued = notifications.filter(n => n.status === "queued");
  const stuck = queued.filter(n => now - new Date(n.created_at).getTime() > TEN_MIN).map(n => n.id);
  check(`no notification stuck 'queued' past 10 minutes (${queued.length} currently queued)`, stuck, queued.length);
}

console.log("\nsummary\n");

const statusTally = new Map<string, number>();
for (const r of reports) statusTally.set(r.status, (statusTally.get(r.status) ?? 0) + 1);
console.log(`  reports:            ${reports.length}`);
for (const [status, n] of [...statusTally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${status.padEnd(18)} ${n}`);
}
console.log(`  report_events:      ${events.length}`);
console.log(`    routed:           ${routedEvents.length}`);
console.log(`  notifications:      ${notifications.length}`);
console.log(`    queued:           ${notifications.filter(n => n.status === "queued").length}`);
console.log(`    sent/delivered:   ${notifications.filter(n => n.status === "sent" || n.status === "delivered").length}`);
console.log(`    failed:           ${notifications.filter(n => n.status === "failed").length}`);
console.log(`  active profiles:    ${profiles.filter(p => p.active).length} / ${profiles.length}`);
console.log(`  courses present:    ${new Set(reports.map(r => r.course_id)).size}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
