/**
 * The triage cron gate must fire for a notification that is due and stay quiet
 * for one waiting out a retry backoff.
 *
 * The gate itself is a pg_cron job, which PGlite cannot schedule, so the
 * predicate is lifted verbatim out of the migration that schedules it and run
 * here. If someone rewrites the clause, this test evaluates the rewritten
 * clause — there is one copy of the rule, and this is a check on it, not a
 * second copy.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort())
  await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
await db.exec(readFileSync("supabase/seed.sql", "utf8"));

const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

const MIGRATION = "supabase/migrations/20260906090000_urgent_escalation_push_retry.sql";
const sql = readFileSync(MIGRATION, "utf8");

console.log("\n1. the index the gate and the worker lean on exists");
const idx = await one<{ indexdef: string }>(
  `select indexdef from pg_indexes where tablename = 'notifications' and indexname = 'notifications_queued_due_idx'`);
check("notifications_queued_due_idx is present", !!idx, "missing");
check("it is partial on status = 'queued'", /WHERE .*status = 'queued'/i.test(idx?.indexdef ?? ""), idx?.indexdef ?? "");
check("it is keyed on next_retry_at", /\(next_retry_at\)/.test(idx?.indexdef ?? ""), idx?.indexdef ?? "");

console.log("\n2. the gate's notifications clause, lifted from the migration");
// The clause inside the cron job body. Matched loosely enough to survive
// re-indentation, tightly enough that a different predicate fails to match.
const m = /exists \(select 1 from notifications\s+where status = 'queued'\s+and \(next_retry_at is null or next_retry_at <= now\(\)\)\)/.exec(sql);
check("clause found in the scheduled job", !!m, "predicate text not found in " + MIGRATION);
const clause = m?.[0] ?? "false";
const due = async () => (await one<{ due: boolean }>(`select ${clause} as due`))!.due;

// Nothing queued to begin with, so every answer below is about the rows this
// test inserts. The seed's own notifications are marked sent.
await db.query(`update notifications set status = 'sent', sent_at = now() where status = 'queued'`);
check("baseline: nothing due", (await due()) === false);

const report = (await one<{ id: string; course_id: string }>(`select id, course_id from reports limit 1`))!;
const profile = (await one<{ id: string }>(`select id from profiles where course_id = $1 limit 1`, [report.course_id]))!.id;
const add = async (nextRetry: string | null) => (await one<{ id: string }>(
  `insert into notifications (report_id, course_id, profile_id, channel, status, next_retry_at)
   values ($1, $2, $3, 'push', 'queued', $4::timestamptz) returning id`,
  [report.id, report.course_id, profile, nextRetry]))!.id;

console.log("\n3. a row waiting out its backoff does not fire the gate");
const waiting = await add(new Date(Date.now() + 5 * 60_000).toISOString());
check("queued with next_retry_at in the future: gate stays closed", (await due()) === false);
// The previous gate — status = 'queued' alone — would have fired here every
// minute for five minutes. Stated so the difference is on the record.
const oldGate = (await one<{ fired: boolean }>(`select exists (select 1 from notifications where status = 'queued') as fired`))!.fired;
check("(the old any-queued gate would have fired)", oldGate === true);

console.log("\n4. a row that is due fires it");
const fresh = await add(null);
check("queued with next_retry_at null: gate opens", (await due()) === true);
await db.query(`update notifications set status = 'sent', sent_at = now() where id = $1`, [fresh]);
check("closed again once that row is sent", (await due()) === false);

const overdue = await add(new Date(Date.now() - 60_000).toISOString());
check("queued with next_retry_at in the past: gate opens", (await due()) === true);
await db.query(`update notifications set status = 'sent', sent_at = now() where id = $1`, [overdue]);

console.log("\n5. the waiting row becomes due when its time arrives");
await db.query(`update notifications set next_retry_at = now() - interval '1 second' where id = $1`, [waiting]);
check("gate opens once the backoff has elapsed", (await due()) === true);

console.log("\n6. a failed row never fires it, whatever its retry time");
await db.query(`update notifications set status = 'failed', failed_at = now() where id = $1`, [waiting]);
check("failed rows are not due", (await due()) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
