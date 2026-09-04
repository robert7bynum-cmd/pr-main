/**
 * Cross-tenant and anonymous access, against the real Supabase project.
 *
 * This exists because every dashboard view was once world-readable: Postgres
 * views run as their owner by default, so RLS on the underlying tables was
 * bypassed. The publishable key ships in the client bundle, so "anonymous"
 * means anyone. Run this after any migration that adds a table or view.
 */
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const TABLES = ["reports", "profiles", "courses", "report_events", "notifications",
  "routing_rules", "departments", "locations", "qr_codes", "triage_queue",
  "pending_profiles", "push_subscriptions"];
const VIEWS = ["staff_queue", "dashboard_today", "dashboard_daily",
  "dashboard_by_department", "dashboard_recurring", "dashboard_by_person"];

let leaks = 0;
async function check(name: string) {
  const res = await fetch(`${URL_}/rest/v1/${name}?select=*&limit=1`, {
    headers: { apikey: PUB, Authorization: `Bearer ${PUB}` },
  });
  const body = await res.text();
  // An empty array is correct. So is a permission error. Rows are a leak.
  const leaked = body.startsWith("[{");
  if (leaked) leaks++;
  console.log(`  ${leaked ? "LEAK" : "ok  "}  ${name}`);
}

console.log("anonymous read access (rows returned = leak):\n");
for (const t of [...TABLES, ...VIEWS]) await check(t);

console.log(`\n${leaks} leak(s)`);
process.exit(leaks ? 1 : 0);
