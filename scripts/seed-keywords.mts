/**
 * Loads the keyword rules from their source of truth into the live database.
 *
 * lib/triage/keywords.ts stays the place rules are written and reviewed;
 * lib/triage/load-rules.ts pushes them into triage_keywords so the SQL matcher
 * — the only matcher — has them. The same loader fills the throwaway Postgres
 * the eval suites run against, so what was tested is what is loaded here.
 * Re-runnable; fails loudly on a duplicate rule rather than dropping it.
 */
import { Client } from "pg";
import { loadRules } from "../lib/triage/load-rules.ts";

const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const counts = await loadRules(c);
  console.log("loaded:", JSON.stringify(counts));
} finally {
  await c.end();
}
