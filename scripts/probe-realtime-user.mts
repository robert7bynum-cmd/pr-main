/** Same probe, but authenticated as a real staff member — exactly what the browser does. */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const db = createClient(url, anon, { auth: { persistSession: false } });

const { data: auth, error } = await db.auth.signInWithPassword({
  email: "gm@beaconhilldemo.com",
  password: process.env.DEMO_PASSWORD ?? "beaconhill-demo-2026",
});
if (error) { console.log("sign-in failed:", error.message); process.exit(1); }
console.log("  signed in as", auth.user?.email);

const courseId = (await db.rpc("me")).data?.[0]?.course_id;
console.log("  course:", courseId);

await db.realtime.setAuth(auth.session!.access_token);

let got = 0;
const ch = db.channel(`probe-user`)
  .on("postgres_changes",
      { event: "*", schema: "public", table: "reports", filter: `course_id=eq.${courseId}` },
      (p) => { got++; console.log(`  EVENT ${p.eventType}`); })
  .subscribe((s, err) => console.log("  status:", s, err?.message ?? ""));

await new Promise((r) => setTimeout(r, 4000));

const h = { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" };
const nonce = await (await fetch(`${url}/rest/v1/rpc/issue_scan_nonce`, {
  method: "POST", headers: h, body: JSON.stringify({ p_token: "bh-h04" }) })).json();
await fetch(`${url}/rest/v1/rpc/submit_report`, { method: "POST", headers: h,
  body: JSON.stringify({ p_token: "bh-h04", p_nonce: nonce, p_body: "user-auth realtime probe" }) });
console.log("  filed, waiting 6s…");

await new Promise((r) => setTimeout(r, 6000));
console.log(`\nevents received as an authenticated staff member: ${got}`);
process.exit(0);
