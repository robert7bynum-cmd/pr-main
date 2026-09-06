/**
 * One member, one report, one staff member — the whole way through, for real.
 *
 * The repo had 117 passing tests on the day the owner said "I scanned the QR
 * code and nothing showed up in the queue." Every one of them was right. The
 * report landed, was triaged, and was routed correctly; he was signed in as Pro
 * Shop, nothing routes to Pro Shop, and his queue was empty. A hundred green
 * assertions about return values, and the product was unusable for a person.
 *
 * So this suite asserts almost nothing about return values. It walks the
 * journey as the actual actors — an anonymous phone browser for the member, a
 * real signed-in session for staff — and the assertion it exists for is number
 * 6: the person who was paged can SEE the thing they were paged about, in their
 * own queue, with their own session. Everything before it sets that up and
 * everything after it is the rest of the shift.
 *
 * It runs against the real production project, because a journey that only
 * works against a throwaway Postgres is exactly the class of proof that failed
 * last time. It creates ONE report, marked in its own body as a test artifact,
 * and leaves it resolved. It deletes nothing.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { provisionTestStaff, deleteReport } from "@/lib/dev/test-staff";
config({ path: ".env.local" });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
// Staff for this run only. The club keeps no demo personas, so the suite brings
// a manager to observe, a maintenance supervisor to be paged, and a pro-shop
// member to NOT be paged — and removes all three, and the report, at the end.
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const fixtures = await provisionTestStaff(admin);
const PASSWORD = fixtures.password;

if (!URL_ || !PUB) {
  console.log("NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY missing from .env.local");
  process.exit(2);
}

// The placard a member would physically be standing at. Hole 7 rather than the
// one test-realtime.mts uses, so two suites running at once cannot trip each
// other's per-placard flood control.
const PLACARD = process.env.E2E_PLACARD_TOKEN ?? "bh-h07";

// The logins this test holds a password for: the three it just created.
const KNOWN_LOGINS = [
  fixtures.supervisor.email,
  fixtures.staff.email,
  fixtures.manager.email,
];

const stamp = new Date().toISOString();
const marker = `E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
// The member's own words come first: this is what the classifier reads, and a
// test that leads with "please ignore" is a test of the wrong sentence. The
// artifact marker goes on the end, where a person clearing the queue will see
// it and the model will not be misled by it.
const BODY =
  `The sprinkler head on the left side of the fairway is broken and spraying ` +
  `across the cart path, and the whole landing area is flooded. ` +
  `[ProResponse automated end-to-end test ${marker} @ ${stamp} — safe to ignore, no action needed]`;

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`);
};
const step = (n: number, title: string) => console.log(`\n${n}. ${title}`);
const note = (s: string) => console.log(`      ${s}`);

const anonClient = () => createClient(URL_, PUB, { auth: { persistSession: false } });

async function signIn(email: string): Promise<SupabaseClient | null> {
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) return null;
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mins = (a: string, b: string) =>
  (new Date(a).getTime() - new Date(b).getTime()) / 60000;

let reportId: string | null = null;
// The staff-filed report from step 12, when the journey gets that far.
let staffReportId: string | null = null;
// Nothing this suite creates outlives it: the reports go, then the people.
// Earlier versions left the report "resolved" as a marked artifact, and those
// piled up in a real club's history until the owner asked for all of it gone.
// A removal that fails is a failed test, not a log line: a leftover is exactly
// what the owner asked never to accumulate again.
const finish = async () => {
  for (const id of [reportId, staffReportId]) {
    if (!id) continue;
    try { await deleteReport(admin, id); console.log(`\n  removed report ${id} (${marker})`); }
    catch (e) {
      check(`removed report ${id}`, false, (e as Error).message);
    }
  }
  await fixtures.teardown();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

// ---------------------------------------------------------------- 1. the scan
// A phone with no account, no cookie and no session. The publishable key is the
// only credential a member ever holds, and it ships in the client bundle, so
// this is precisely the privilege a stranger in the car park has.
step(1, "a member scans the placard on the hole");
const member = anonClient();

const { data: nonce, error: nonceErr } = await member.rpc("issue_scan_nonce", {
  p_token: PLACARD,
});
check("the placard hands out a scan nonce", typeof nonce === "string" && nonce.length > 0,
  nonceErr?.message ?? String(nonce));
if (typeof nonce !== "string") await finish();

// -------------------------------------------------------------- 2. the report
step(2, "and types one sentence about what they see");
const { data: submitted, error: submitErr } = await member.rpc("submit_report", {
  p_token: PLACARD,
  p_nonce: nonce,
  p_body: BODY,
  p_language: "en",
});
check("the report is accepted with no account and no sign-in",
  !submitErr && typeof submitted === "string", submitErr?.message ?? String(submitted));
if (typeof submitted !== "string") await finish();
reportId = submitted;
note(`report ${reportId}`);

// That is the member's entire involvement. Everything below is staff, and none
// of it is visible to the person who filed it.

// A staff session is needed just to observe. Management is the honest choice
// for the observer, because reading the whole club's reports is their actual
// job — but note that observation is all it is used for. The assertion that
// matters is made further down, by the person who was paged.
const observer = await signIn(fixtures.manager.email);
check("a manager can sign in to watch the report land", Boolean(observer),
  "the fixture manager could not sign in");
if (!observer) await finish();
const obs = observer!;

// ------------------------------------------------- 3. bound to the right hole
step(3, "the report is filed against the hole the member was standing on");
const { data: placard } = await obs
  .from("qr_codes")
  .select("location_id")
  .eq("token", PLACARD)
  .limit(1);
const placardLocation = (placard as { location_id: string }[] | null)?.[0]?.location_id;

const readReport = async (client: SupabaseClient) => {
  const { data } = await client
    .from("reports")
    .select(
      "id,status,category,urgency,body,location_id,department_id,created_at," +
        "acknowledged_at,claimed_by,resolved_at,resolved_by,resolution_note," +
        "member_message,member_notified_at",
    )
    .eq("id", reportId!)
    .limit(1);
  return ((data ?? [])[0] ?? null) as unknown as Record<string, unknown> | null;
};

let report = await readReport(obs);
check("the report exists in the club's data", Boolean(report), "not readable by staff");
// A report filed against the wrong hole sends a crew member to the wrong place,
// which is worse than never filing it: they lose the trip AND the trust.
check("it is bound to the placard's own location",
  Boolean(report) && report!.location_id === placardLocation,
  `${report?.location_id} != ${placardLocation}`);
check("the member's words are stored verbatim", report?.body === BODY);

// ------------------------------------------------------------- 4. the triage
step(4, "the triage worker picks it up on its own");
// Nothing is invoked by hand here. pg_cron pokes the edge function every
// minute; if that schedule is broken, this is the test that notices, and
// "nobody triaged my report" is what the member experiences when it is.
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  report = await readReport(obs);
  if (report && report.status !== "new") break;
  await sleep(3000);
}
const triaged = Boolean(report) && report!.status !== "new";
check("it stops being untouched within two minutes", triaged,
  `still ${report?.status} — the scheduled sweep may not be running`);
check("a category is assigned", Boolean(report?.category), String(report?.category));
if (report?.category) note(`category ${report.category}, urgency ${report.urgency}`);

const readEvents = async (client: SupabaseClient) => {
  const { data } = await client
    .from("report_events")
    .select("type,actor_id,payload,created_at")
    .eq("report_id", reportId!)
    .order("created_at");
  return (data ?? []) as {
    type: string;
    actor_id: string | null;
    payload: Record<string, unknown> | null;
    created_at: string;
  }[];
};

let events = await readEvents(obs);
// Every metric on a GM's screen derives from these rows, so an action that
// moved the report without writing one is an action that never happened as far
// as the club's numbers are concerned.
check("a triaged event is on the record", events.some((e) => e.type === "triaged"),
  events.map((e) => e.type).join(","));
if (!triaged) await finish();

// ------------------------------------------------------------- 5. the routing
step(5, "and routes it to a department, naming who was told");
check("a department is set", Boolean(report?.department_id), "no department_id");
const routed = events.find((e) => e.type === "routed");
check("a routed event is on the record", Boolean(routed));
// Silence is never a valid outcome. A routing that reached nobody must not be
// able to look like a success — that was the triage worker counting ten skipped
// reports as routed.
const recipients = Number(routed?.payload?.recipients ?? 0);
check("it reached at least one person", recipients > 0, `recipients=${recipients}`);
if (routed) note(`${recipients} notified, reason ${String(routed.payload?.reason)}`);

// -------------------------------------------- 6. THE ONE THAT MATTERS
step(6, "the person who was paged can see it in their own queue");

const { data: notifRows } = await obs
  .from("notifications")
  .select("profile_id,created_at")
  .eq("report_id", reportId!)
  .order("created_at");
const notified = (notifRows ?? []) as { profile_id: string; created_at: string }[];
check("somebody is on the notification list", notified.length > 0);
if (!notified.length) await finish();

const { data: peopleRows } = await obs
  .from("profiles")
  .select("id,full_name,email,role");
const people = (peopleRows ?? []) as {
  id: string;
  full_name: string;
  email: string | null;
  role: string;
}[];
const personOf = (id: string) => people.find((p) => p.id === id);
for (const n of notified) {
  const p = personOf(n.profile_id);
  note(`paged: ${p?.full_name ?? n.profile_id} (${p?.role ?? "?"}) ${p?.email ?? ""}`);
}

// Prefer a notified person who is NOT management. my_queue shows managers and
// owners everything at the club by design, so proving a manager can see it
// proves only that managers see everything — which is true whether or not
// routing worked. A department member seeing it is the real claim.
const notifiedKnown = notified
  .map((n) => ({ n, p: personOf(n.profile_id) }))
  .filter((x) => x.p?.email && KNOWN_LOGINS.includes(x.p.email))
  .sort((a, b) => {
    const mgmt = (r?: string) => (r === "manager" || r === "owner" ? 1 : 0);
    return mgmt(a.p?.role) - mgmt(b.p?.role);
  });

const notifiedButUnreachable = notified.filter(
  (n) => !KNOWN_LOGINS.includes(personOf(n.profile_id)?.email ?? ""),
);
if (notifiedButUnreachable.length) {
  note(
    `${notifiedButUnreachable.length} of ${notified.length} notified people are seeded ` +
      `profiles with no login this test holds a password for; they are not signed in as.`,
  );
}

check("at least one notified person has a login this test can use",
  notifiedKnown.length > 0,
  "no notified person is a demo persona — cannot prove reachability by signing in");
if (!notifiedKnown.length) {
  // Be loud about the weaker claim rather than dressing it up as the strong one.
  note("LIMITATION: falling back to no reachability proof at all. The report was");
  note("routed and notifications were queued, but nobody this test can authenticate");
  note("as was among the recipients, so it cannot show a real person seeing it.");
  await finish();
}

const chosen = notifiedKnown[0];
const chosenPerson = chosen.p!;
const isManagement = chosenPerson.role === "manager" || chosenPerson.role === "owner";
if (isManagement) {
  note(
    `LIMITATION: the only notified person with a usable login is ${chosenPerson.role} ` +
      `${chosenPerson.full_name}, and my_queue shows management the whole club. This ` +
      `proves they can see it; it does not isolate routing as the reason.`,
  );
}

const staff = await signIn(chosenPerson.email!);
check(`${chosenPerson.full_name} can sign in`, Boolean(staff), chosenPerson.email!);
if (!staff) await finish();
const me = staff!;

const { data: meRows } = await me.rpc("me");
const actor = (meRows as { profile_id: string }[] | null)?.[0]?.profile_id;
check("their session resolves to their own profile", actor === chosenPerson.id,
  `${actor} != ${chosenPerson.id}`);

const inQueue = async (client: SupabaseClient, view: "my_queue" | "staff_queue") => {
  const { data, error } = await client.from(view).select("id,status,department_key");
  if (error) return { rows: null as null | { id: string }[], error: error.message };
  return { rows: (data ?? []) as { id: string }[], error: "" };
};

const mine = await inQueue(me, "my_queue");
// THE assertion. Not "the row exists", not "staff_queue contains it" — the
// signed-in human whose phone buzzed, reading the exact view the app renders
// for them, finds the thing they were buzzed about.
check(`the report is in ${chosenPerson.full_name}'s own queue`,
  Boolean(mine.rows?.some((r) => r.id === reportId)),
  mine.error || `my_queue held ${mine.rows?.length ?? 0} rows, none of them this report`);

// And the other half of the same sentence: my_queue is not simply "everything".
// If it were, the assertion above would pass for a person who cannot act on the
// report — which is the exact shape of the original bug, in reverse.
const bystanderEmail = KNOWN_LOGINS.find((e) => {
  const p = people.find((x) => x.email === e);
  return (
    p &&
    p.id !== chosenPerson.id &&
    p.role !== "manager" &&
    p.role !== "owner" &&
    !notified.some((n) => n.profile_id === p.id)
  );
});
if (bystanderEmail) {
  const bystander = await signIn(bystanderEmail);
  if (bystander) {
    const theirs = await inQueue(bystander, "my_queue");
    const bystanderName = people.find((p) => p.email === bystanderEmail)?.full_name;
    check(`${bystanderName}, who was not paged, does not see it`,
      !theirs.rows?.some((r) => r.id === reportId),
      "my_queue is showing this person work that was never routed to them");
    await bystander.auth.signOut();
  }
} else {
  note("no non-management persona outside the recipient list — skipped the mirror check");
}

// ------------------------------------------------------- 7. the acknowledgement
step(7, "they acknowledge it from their own session");
// The same RPC app/actions/report-actions.ts calls, with the same actor
// lib/queue/actions-db.ts supplies — the authenticated user, never a guess.
const { data: ackRows, error: ackErr } = await me.rpc("acknowledge_report", {
  p_report_id: reportId,
  p_actor: actor,
});
const ack = (Array.isArray(ackRows) ? ackRows[0] : ackRows) as
  | { ok: boolean; claimed_by_name: string | null }
  | null;
check("the acknowledgement is accepted", !ackErr && ack?.ok === true,
  ackErr?.message ?? JSON.stringify(ack));

report = await readReport(me);
check("the report now carries an acknowledged time", Boolean(report?.acknowledged_at),
  String(report?.acknowledged_at));
check("and is claimed by the person who acknowledged it", report?.claimed_by === actor,
  `${report?.claimed_by} != ${actor}`);

events = await readEvents(me);
const ackEvent = events.find((e) => e.type === "acknowledged");
check("an acknowledged event is on the record", Boolean(ackEvent));
// An unattributed action corrupts the accountability data the product is sold
// on, so an event with no actor is as bad as no event.
check("the event names who did it", ackEvent?.actor_id === actor,
  `${ackEvent?.actor_id} != ${actor}`);

// ----------------------------------------------------------- 8. the two clocks
step(8, "the response clock starts when they were told, not when the member typed");
const notifiedAt = notified.find((n) => n.profile_id === actor)?.created_at
  ?? notified[0].created_at;
const createdAt = String(report?.created_at);
const acknowledgedAt = String(report?.acknowledged_at);

const memberClock = mins(acknowledgedAt, createdAt);       // the member's experience
const accountableClock = mins(acknowledgedAt, notifiedAt); // what a person answers for
const routingDelay = mins(notifiedAt, createdAt);
note(`member ${memberClock.toFixed(2)}m = routing ${routingDelay.toFixed(2)}m + ` +
     `staff ${accountableClock.toFixed(2)}m`);

check("they were notified after the member filed it", routingDelay > 0,
  `notification at or before creation (${routingDelay.toFixed(3)}m)`);
check("nobody is charged before they were told", accountableClock >= 0,
  `${accountableClock.toFixed(3)}m`);
// If the two were conflated, the person would be billed for the minutes triage
// and routing took — time they had no part in and cannot shorten. That is how
// staff stop trusting the numbers, and once they stop the data is worthless.
check("the two clocks are genuinely different numbers",
  accountableClock < memberClock,
  `${accountableClock.toFixed(3)}m vs ${memberClock.toFixed(3)}m — routing delay is ` +
    `being charged to the responder`);

// ---------------------------------------------------------------- 9. the fix
step(9, "they resolve it with a note for the file");
const INTERNAL_NOTE =
  `Automated end-to-end test ${marker}. No physical issue existed; nothing was ` +
  `dispatched. Internal note only — this text must never reach a member.`;
const { error: resolveErr } = await me.rpc("resolve_report", {
  p_report_id: reportId,
  p_actor: actor,
  p_internal_note: INTERNAL_NOTE,
  // ProResponse is an operations tool: the app passes null here, always.
  p_member_message: null,
});
check("the resolution is accepted", !resolveErr, resolveErr?.message ?? "");

report = await readReport(me);
check("the report is resolved", report?.status === "resolved", String(report?.status));
check("with a resolved time", Boolean(report?.resolved_at), String(report?.resolved_at));
check("and the person who resolved it", report?.resolved_by === actor,
  `${report?.resolved_by} != ${actor}`);

events = await readEvents(me);
const resolvedEvent = events.find((e) => e.type === "resolved");
check("a resolved event is on the record", Boolean(resolvedEvent));
check("the event names who did it", resolvedEvent?.actor_id === actor,
  `${resolvedEvent?.actor_id} != ${actor}`);

// ------------------------------------------------------- 10. confidentiality
step(10, "the note staff wrote for themselves stays with staff");
check("the internal note is stored", report?.resolution_note === INTERNAL_NOTE);
// Separate columns, always. Staff write candidly for their own record; the
// moment a member can read it, they stop writing honestly and the file is
// worthless.
check("nothing was written to the member-facing message",
  report?.member_message === null, String(report?.member_message));
check("and the member was never notified", report?.member_notified_at === null,
  String(report?.member_notified_at));
check("no member-facing field contains the note text",
  !String(report?.member_message ?? "").includes("Internal note only") &&
    !String(report?.member_message ?? "").includes(marker));

// Belt and braces: prove the member has no read path at all, from the same
// anonymous client that filed the report. Anon holds zero table privileges and
// the member status lookup was removed outright.
const { error: anonReadErr } = await member.from("reports").select("resolution_note").limit(1);
check("an anonymous client cannot read reports at all", Boolean(anonReadErr),
  "anon returned rows from reports");
const { error: lookupErr } = await member.rpc("get_report_status", {
  p_tracking_token: "anything",
});
check("and there is no member-facing status lookup to leak through",
  Boolean(lookupErr), "get_report_status is still reachable anonymously");

// ------------------------------------------------ 11. it leaves the queue
step(11, "and it drops off the board");
const stillOpen = await inQueue(me, "staff_queue");
// Open reports only. A resolved item that lingers is the reason a queue stops
// being read, and a queue nobody reads is worse than no queue.
check("the resolved report is gone from the course-wide queue",
  !stillOpen.rows?.some((r) => r.id === reportId),
  stillOpen.error || "still listed as open");
const stillMine = await inQueue(me, "my_queue");
check("and gone from their own queue too",
  !stillMine.rows?.some((r) => r.id === reportId), stillMine.error || "still listed");

await me.auth.signOut();

// --------------------------------------------- 12. staff file reports too
step(12, "a staff member files one themselves, and it takes the same road");
// The superintendent on the morning drive, or the pro shop with a member on
// the line. No placard, no nonce: a session, a hole and a sentence. From the
// row down it must be the member's journey again — triage picks it up unasked,
// routes it, pages somebody — and the filer must keep seeing it.
const STAFF_BODY =
  `Sprinkler head stuck on beside the cart path, water pooling on the approach. ` +
  `[ProResponse automated end-to-end test ${marker} E2E staff-filed — safe to ignore, no action needed]`;

const filerSession = await signIn(fixtures.supervisor.email);
check("the fixture supervisor can sign in to file", Boolean(filerSession),
  "the fixture supervisor could not sign in");
if (!filerSession) await finish();
const filer = filerSession!;

const { data: filerMe } = await filer.rpc("me");
const filerId = (filerMe as { profile_id: string }[] | null)?.[0]?.profile_id;

const { data: filedData, error: fileErr } = await filer.rpc("file_report", {
  p_location_id: placardLocation,
  p_body: STAFF_BODY,
  p_source: "staff",
});
check("the report is accepted from a staff session", !fileErr && typeof filedData === "string",
  fileErr?.message ?? String(filedData));
if (typeof filedData !== "string") await finish();
staffReportId = filedData as string;
note(`report ${staffReportId}`);

const readStaffReport = async () => {
  const { data } = await filer
    .from("reports")
    .select("id,status,category,source,filed_by,location_id,department_id")
    .eq("id", staffReportId!)
    .limit(1);
  return ((data ?? [])[0] ?? null) as unknown as Record<string, unknown> | null;
};

let staffReport = await readStaffReport();
check("it is on the hole they chose", staffReport?.location_id === placardLocation,
  `${staffReport?.location_id} != ${placardLocation}`);
check("its source says staff", staffReport?.source === "staff", String(staffReport?.source));
check("and filed_by is the person whose session filed it", staffReport?.filed_by === filerId,
  `${staffReport?.filed_by} != ${filerId}`);

// Same unattended wait as step 4: nothing is invoked by hand.
const staffDeadline = Date.now() + 120_000;
while (Date.now() < staffDeadline) {
  staffReport = await readStaffReport();
  if (staffReport && staffReport.status !== "new") break;
  await sleep(3000);
}
const staffTriaged = Boolean(staffReport) && staffReport!.status !== "new";
check("triage picks it up within two minutes, unasked", staffTriaged,
  `still ${staffReport?.status} — the scheduled sweep may not be running`);
if (staffTriaged) note(`category ${staffReport?.category}`);

const { data: staffEventRows } = await filer
  .from("report_events")
  .select("type,actor_id,payload")
  .eq("report_id", staffReportId!)
  .order("created_at");
const staffEvents = (staffEventRows ?? []) as {
  type: string; actor_id: string | null; payload: Record<string, unknown> | null;
}[];
const staffCreated = staffEvents.find((e) => e.type === "created");
check("the created event names the filer as actor", staffCreated?.actor_id === filerId,
  `${staffCreated?.actor_id} != ${filerId}`);
const staffRouted = staffEvents.find((e) => e.type === "routed");
check("a routed event is on the record", Boolean(staffRouted),
  staffEvents.map((e) => e.type).join(","));
check("and it reached at least one person", Number(staffRouted?.payload?.recipients ?? 0) > 0,
  `recipients=${staffRouted?.payload?.recipients}`);

// The filer, in their own queue, through the view the app renders — with the
// columns the card now shows. The fixture supervisor is in Course Maintenance,
// so on a sprinkler report this proves the columns live rather than isolating
// the filed_by clause; test:queue pins that clause with a pro shop filer.
const { data: filerQueue, error: filerQueueErr } = await filer
  .from("my_queue")
  .select("id,filed_by,filed_by_name,source");
const filerRow = ((filerQueue ?? []) as {
  id: string; filed_by: string | null; filed_by_name: string | null; source: string;
}[]).find((r) => r.id === staffReportId);
check("the report is in the filer's own queue", Boolean(filerRow),
  filerQueueErr?.message || `my_queue held ${filerQueue?.length ?? 0} rows, none of them this report`);
check("and the queue says who filed it",
  filerRow?.filed_by === filerId && filerRow?.filed_by_name === fixtures.supervisor.full_name
    && filerRow?.source === "staff",
  JSON.stringify(filerRow ?? {}));

await filer.auth.signOut();
await obs.auth.signOut();

// Both reports are removed in finish(), then the people.
finish();
