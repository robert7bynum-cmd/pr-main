/**
 * Can a signed-in staff member forge an action, against the real project?
 *
 * The six staff actions take the actor as an argument and are SECURITY
 * DEFINER, so RLS never constrained them. Until assert_actor existed, the only
 * thing stopping someone resolving a report in a colleague's name was the app
 * choosing to pass the right id — a convention, not a control.
 *
 * That matters here more than it would elsewhere. The accountability record is
 * the product: a GM answers "who handled it, and how fast" from these events.
 * An actor the caller picks makes that record forgeable, which is worse than
 * not collecting it, because it still looks authoritative.
 *
 * Every attempt below MUST be refused. Nothing is mutated: if any of these
 * succeeded the test would fail, and the point is that they cannot.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { provisionTestStaff, deleteReport } from "@/lib/dev/test-staff";
config({ path: ".env.local" });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const fixtures = await provisionTestStaff(admin);
const PW = fixtures.password;

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

const staff = createClient(URL_, PUB, { auth: { persistSession: false } });
const { error: inErr } = await staff.auth.signInWithPassword({
  email: fixtures.staff.email, password: PW,
});
check("a line staff member can sign in", !inErr, inErr?.message ?? "");

const { data: meRows } = await staff.rpc("me");
const me = (meRows as { profile_id: string; full_name: string }[] | null)?.[0];
check("and resolves to their own profile", Boolean(me?.profile_id));

// Somebody else entirely, and a report of this suite's own to attempt
// against — never a real one. An earlier version grabbed the first open
// report at the club, which with the demo data gone was the owner's.
const someoneElse = { id: fixtures.supervisor.id, full_name: fixtures.supervisor.full_name };
const anon = createClient(URL_, PUB, { auth: { persistSession: false } });
const { data: nonce } = await anon.rpc("issue_scan_nonce", { p_token: "bh-h13" });
const { error: subErr } = await anon.rpc("submit_report", {
  p_token: "bh-h13", p_nonce: nonce,
  p_body: `AUTHZ PROBE ${Date.now()} — cart path washed out by the 13th green`, p_language: "en",
});
const { data: targetRows } = await admin.from("reports").select("id")
  .ilike("body", "AUTHZ PROBE %").order("created_at", { ascending: false }).limit(1);
const target = (targetRows ?? [])[0] as { id: string } | undefined;
check("there is a report of our own to attempt against", !subErr && Boolean(target?.id), subErr?.message ?? "");

const refused = async (fn: string, args: Record<string, unknown>) => {
  const { error } = await staff.rpc(fn, args);
  return error?.message ?? null;
};

console.log("\nforging the actor");
for (const [fn, args] of [
  ["acknowledge_report", { p_report_id: target!.id, p_actor: someoneElse.id }],
  ["start_report", { p_report_id: target!.id, p_actor: someoneElse.id }],
  ["resolve_report", { p_report_id: target!.id, p_actor: someoneElse.id,
                       p_internal_note: "forged", p_member_message: null }],
  ["close_no_action", { p_report_id: target!.id, p_actor: someoneElse.id,
                        p_reason: "invalid" }],
] as [string, Record<string, unknown>][]) {
  const msg = await refused(fn, args);
  check(`${fn} refuses an action attributed to someone else`, msg !== null,
    "IT WAS ACCEPTED — the accountability record is forgeable");
}

console.log("\nreaching past the club");
const ghost = "00000000-0000-0000-0000-0000000000ff";
const missing = await refused("acknowledge_report",
  { p_report_id: ghost, p_actor: me!.profile_id });
check("a report that does not exist is refused", missing !== null);
check("and says only 'report not found', so ids cannot be probed",
  Boolean(missing?.includes("report not found")), missing ?? "");

console.log("\nthe worker's own functions are not a staff API");
for (const [fn, args] of [
  ["route_report", { p_report_id: target!.id, p_category: "safety",
                     p_urgency: "urgent", p_summary: "forced", p_confidence: 1,
                     p_source: "keyword" }],
  ["claim_triage_batch", { p_limit: 10 }],
  ["escalate_reports", {}],
  ["resolve_recipients", { p_course_id: ghost, p_department_id: ghost }],
] as [string, Record<string, unknown>][]) {
  const msg = await refused(fn, args);
  check(`${fn} is not callable by a signed-in staff member`, msg !== null,
    "IT WAS ACCEPTED");
}

console.log("\nand the legitimate path still works");
const mine = await refused("acknowledge_report",
  { p_report_id: target!.id, p_actor: me!.profile_id });
check("acting as yourself is allowed", mine === null, mine ?? "");

await staff.auth.signOut();
if (target?.id) await deleteReport(admin, target.id);
await fixtures.teardown();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
