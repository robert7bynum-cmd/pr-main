/**
 * Supabase's auth service cannot scan NULL into its token columns — a seeded
 * auth.users row with them left NULL makes every admin user lookup fail with
 * "Database error finding users", which breaks demo sign-in and any future
 * staff invite. Empty string is what GoTrue expects.
 */
import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const cols = ["confirmation_token","recovery_token","email_change_token_new","email_change",
  "email_change_token_current","phone_change","phone_change_token","reauthentication_token"];
let fixed = 0;
for (const col of cols) {
  const r = await c.query(
    `update auth.users set ${col} = '' where ${col} is null`);
  if (r.rowCount) { console.log(`  ${col}: ${r.rowCount} rows`); fixed += r.rowCount; }
}
await c.query(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, created_at),
                                     confirmed_at_shadow = null where false`).catch(() => {});
console.log(fixed ? `repaired ${fixed} column values` : "nothing to repair");
await c.end();
