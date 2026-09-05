/**
 * Does realtime deliver at all? Subscribes with the service role (bypasses RLS)
 * and files a report. If nothing arrives, the problem is the realtime service or
 * publication. If it arrives, the problem is client authorisation.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key, { auth: { persistSession: false } });

let got = 0;
const ch = db.channel("probe")
  .on("postgres_changes", { event: "*", schema: "public", table: "reports" }, (p) => {
    got++;
    console.log(`  EVENT ${p.eventType} received`);
  })
  .subscribe((s) => console.log("  subscribe status:", s));

await new Promise((r) => setTimeout(r, 4000));

const pub = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const h = { apikey: pub, Authorization: `Bearer ${pub}`, "Content-Type": "application/json" };
const nonce = await (await fetch(`${url}/rest/v1/rpc/issue_scan_nonce`, {
  method: "POST", headers: h, body: JSON.stringify({ p_token: "bh-h02" }),
})).json();
await fetch(`${url}/rest/v1/rpc/submit_report`, {
  method: "POST", headers: h,
  body: JSON.stringify({ p_token: "bh-h02", p_nonce: nonce, p_body: "realtime probe" }),
});
console.log("  report filed, waiting 6s for an event…");

await new Promise((r) => setTimeout(r, 6000));
console.log(`\nevents received: ${got}`);
await db.removeChannel(ch);
process.exit(0);
