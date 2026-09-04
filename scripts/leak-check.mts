/** Confirms the internal resolution note never reaches the member's page. */
import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query<{ tracking_token: string; resolution_note: string; member_message: string }>(
  `select tracking_token, resolution_note, member_message from reports
    where status='resolved' and member_message is not null and resolution_note is not null limit 5`);
let leaks = 0;
for (const row of r.rows) {
  const html = await (await fetch(`http://localhost:3000/s/${row.tracking_token}`)).text();
  const noteLeaked = html.includes(row.resolution_note);
  const msgShown = html.includes(row.member_message);
  if (noteLeaked) leaks++;
  console.log(`  ${noteLeaked ? "LEAK" : "ok  "}  member sees message: ${msgShown ? "yes" : "NO"}`);
  console.log(`         internal: "${row.resolution_note.slice(0, 52)}"`);
  console.log(`         member:   "${row.member_message.slice(0, 52)}"`);
}
console.log(`\n${leaks} leaks across ${r.rows.length} resolved reports`);
await c.end();
process.exit(leaks ? 1 : 0);
