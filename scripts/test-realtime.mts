/**
 * Does the staff queue actually update by itself, against the real project?
 *
 * This is the one feature that cannot be proven by any other suite. The
 * realtime socket authenticates separately from the REST client: without being
 * handed the session token it connects as `anon`, and since anon holds no table
 * grants its RLS check fails silently — the channel reports SUBSCRIBED and then
 * delivers nothing, forever. The indicator says "Live" the entire time.
 *
 * That is not a hypothetical. It is how this broke, it survived every existing
 * test, and it was only caught by a person watching a screen and seeing
 * nothing. So: subscribe exactly the way the browser does, file a report the
 * way a member does, and require the event to arrive.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: ".env.local" });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const EMAIL = process.env.REALTIME_TEST_EMAIL;
const PASSWORD = process.env.DEMO_PASSWORD ?? "beaconhill-demo-2026";

if (!EMAIL) {
  console.log("REALTIME_TEST_EMAIL not set — pass a staff email to run this");
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

const supabase = createClient(URL_, PUB, { auth: { persistSession: false } });
const { data: session, error: signInError } = await supabase.auth.signInWithPassword({
  email: EMAIL, password: PASSWORD,
});
check("staff can sign in", !signInError && Boolean(session.session), signInError?.message ?? "");
if (!session.session) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const token = session.session.access_token;
const { data: meRows } = await supabase.rpc("me");
const courseId = (meRows as { course_id: string }[] | null)?.[0]?.course_id;
check("the session resolves to a club", Boolean(courseId), JSON.stringify(meRows));

// The line whose absence caused the outage.
await supabase.realtime.setAuth(token);

const events: string[] = [];
let subscribed = false;
const channel = supabase
  .channel(`verify-${Math.random().toString(36).slice(2, 8)}`)
  .on("postgres_changes",
      { event: "*", schema: "public", table: "reports", filter: `course_id=eq.${courseId}` },
      (payload) => events.push(payload.eventType))
  .subscribe((status) => { if (status === "SUBSCRIBED") subscribed = true; });

const waitFor = async (fn: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await new Promise(r => setTimeout(r, 250)); }
  return fn();
};

check("the channel subscribes", await waitFor(() => subscribed, 15_000));

// SUBSCRIBED means the channel joined, not that the server has finished
// registering the postgres_changes binding. Submitting the instant that status
// arrives loses the event, and the first version of this test failed exactly
// that way and blamed the product. The app survives this race because it also
// polls every 20 seconds; a test with no such fallback has to wait.
await new Promise(r => setTimeout(r, 5000));

// File the way a member does: an anonymous client, a real placard, a real
// nonce. Using the service role here would prove the socket works for a
// privileged writer and tell us nothing about the path that matters.
const anon = createClient(URL_, PUB, { auth: { persistSession: false } });
const token_ = "bh-h11";
const { data: nonce, error: nonceErr } = await anon.rpc("issue_scan_nonce", { p_token: token_ });
check("a member can obtain a scan nonce", Boolean(nonce) && !nonceErr, nonceErr?.message ?? "");

const body = `Realtime verification ${new Date().toISOString()}`;
const { error: submitErr } = await anon.rpc("submit_report", {
  p_token: token_, p_nonce: nonce, p_body: body, p_language: "en",
});
check("the report is accepted", !submitErr, submitErr?.message ?? "");

const arrived = await waitFor(() => events.length > 0, 20_000);
check("the staff queue is told about it over the socket", arrived,
  "no postgres_changes event in 20s — the socket is connected but deaf, which is what an unauthenticated realtime connection looks like");

await supabase.removeChannel(channel);
await supabase.auth.signOut();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
