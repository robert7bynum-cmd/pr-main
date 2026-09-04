/**
 * Server-side push delivery behaviour.
 *
 * The browser half cannot be exercised headlessly, so this checks the part that
 * silently rots: what happens to a queued notification when nobody has a
 * subscription. Leaving it queued forever would let a club believe staff were
 * notified when they were not.
 */
import { deliverQueuedPush } from "../lib/notify/push.ts";
import { Client } from "pg";

const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const before = await c.query(`select status, count(*)::int n from notifications group by 1 order by 1`);
console.log("before:", before.rows.map(r => `${r.status}=${r.n}`).join("  "));

const res = await deliverQueuedPush(100);
console.log("delivery run:", JSON.stringify(res));

const after = await c.query(`select status, count(*)::int n from notifications group by 1 order by 1`);
console.log("after: ", after.rows.map(r => `${r.status}=${r.n}`).join("  "));

const stuck = await c.query(
  `select count(*)::int n from notifications where status='queued' and created_at < now() - interval '1 minute'`);
console.log(`\nstale queued notifications: ${stuck.rows[0].n} (should be 0 — a stuck queue hides missed alerts)`);

const noSub = await c.query(
  `select count(*)::int n from notifications where status='failed' and error='no push subscription'`);
console.log(`marked failed for having no subscribed device: ${noSub.rows[0].n}`);
await c.end();
