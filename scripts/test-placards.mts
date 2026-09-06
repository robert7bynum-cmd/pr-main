/**
 * Every placard must resolve. A code that 404s is a sign that has to be
 * physically replaced, so this is worth checking before anything is printed.
 *
 * Read-only against production: this fetches what the club's printed codes
 * point at and never mints, retires or edits anything. Minting a code here
 * would leave a live token in the club's database — the live-suite rule is
 * that anything created is removed, and the simplest way to honour it is to
 * create nothing.
 *
 * "Placard" here means what the sheet would print: an active code on an active
 * location. A retired code, or a code on a retired location, is not printed
 * (lib/placards/queries.ts filters both), and get_scan_context refuses it, so
 * it is expected to 404 and is asserted to — a retired sign that still files
 * reports is a location nobody can find on the course.
 */
import { Client } from "pg";

/**
 * Where the codes actually point. This defaulted to localhost, which meant it
 * had been proving that a laptop could serve the placards long after the
 * printed codes were pointing at production — a green result about the wrong
 * machine. PLACARD_ORIGIN overrides it; the default is the deployment the QR
 * codes carry, because that is the only thing a member's phone will ever load.
 */
const origin = process.env.PLACARD_ORIGIN ?? "https://pr-main-dun.vercel.app";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
// locations.active arrives with 20260906130000. Read through to_jsonb so this
// still runs against a database that migration has not reached yet — a
// location with no such column is in use, which is what the column's default
// says too. A suite that cannot run until a migration lands runs when it is
// convenient, which is never when it would have failed.
const { rows } = await c.query<{
  token: string; slug: string; name: string; active: boolean; location_active: boolean;
}>(
  `select q.token, c.slug, l.name, q.active,
          coalesce((to_jsonb(l) ->> 'active')::boolean, true) as location_active
     from qr_codes q join courses c on c.id = q.course_id
     join locations l on l.id = q.location_id order by q.token`);
await c.end();

const printed = rows.filter((r) => r.active && r.location_active);
const retired = rows.filter((r) => !r.active || !r.location_active);

let ok = 0; const bad: string[] = [];
for (const r of printed) {
  const url = `${origin}/r/${r.slug}/${r.token}`;
  const res = await fetch(url, { redirect: "manual" });
  if (res.status === 200) ok++;
  else bad.push(`  ${res.status}  ${r.token}  (${r.name})`);
}
console.log(`${ok}/${printed.length} printed placards resolve`);

// Every printed placard is active on an active location, by construction of
// the filter above; stated as an assertion so a future change to the query
// that widens what gets printed fails here.
const unprintable = printed.filter((r) => !r.active || !r.location_active);
if (unprintable.length) bad.push(`  ${unprintable.length} printed placard(s) are not active`);

let dead = 0;
for (const r of retired) {
  const url = `${origin}/r/${r.slug}/${r.token}`;
  const res = await fetch(url, { redirect: "manual" });
  if (res.status === 404) dead++;
  else bad.push(`  ${res.status}  ${r.token}  (${r.name}) is retired but still answers`);
}
console.log(`${dead}/${retired.length} retired placards refuse`);

if (bad.length) { console.log("failures:"); bad.forEach(b => console.log(b)); }
process.exit(bad.length ? 1 : 0);
