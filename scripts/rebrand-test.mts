/** Proves the token layer: rebrand a club by changing one settings row. */
import { Client } from "pg";
const [primary, ink] = process.argv.slice(2);
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query(
  `update courses set settings = jsonb_set(settings, '{branding}',
     jsonb_build_object('primary', $1::text, 'ink', $2::text,
                        'surface', '#FFFFFF', 'logo_url', null))
   where slug = 'beacon-hill'`, [primary, ink]);
console.log(`branding -> primary ${primary}, ink ${ink}`);
await c.end();
