import { Client } from "pg";
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const open = await c.query(`select tracking_token from reports where status in ('new','triaged','acknowledged') limit 1`);
const done = await c.query(`select tracking_token from reports where status='resolved' and member_message is not null limit 1`);
console.log("open:", open.rows[0]?.tracking_token);
console.log("resolved:", done.rows[0]?.tracking_token);
await c.end();
