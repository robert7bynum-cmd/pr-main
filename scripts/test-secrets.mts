/**
 * The two secrets the database keeps for itself, and who may ask for them.
 *
 * 20260906160000 moved the service-role key and the Anthropic key out of
 * app_settings into Supabase Vault and put one accessor in front of each.
 * PGlite has no vault, so this suite exercises the app_settings branch of the
 * accessors and reads the migration text for the rest: that every job body
 * asks the accessor rather than the table, and that the accessors are not
 * callable by a staff session.
 *
 * Also the response headers in next.config.ts, read as text — the config is
 * a build-time file with no runtime to ask, and the five names are the whole
 * contract.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const db = await PGlite.create({ extensions: { pgcrypto } });
await db.exec(readFileSync("supabase/test-bootstrap.sql", "utf8"));
const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) await db.exec(readFileSync(join("supabase/migrations", f), "utf8"));
await db.exec(readFileSync("supabase/seed.sql", "utf8"));

const one = async <T>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  -> " + d}`); };

// Test values only: shaped nothing like a real key, never leave this process.
const SERVICE = "test-service-role-" + Math.random().toString(36).slice(2);
const ANTHROPIC = "test-anthropic-" + Math.random().toString(36).slice(2);

console.log("\n1. without a vault, the accessors answer from app_settings");
check("no vault in PGlite (the branch under test is the fallback)",
  (await one<{ v: string | null }>(`select to_regclass('vault.decrypted_secrets')::text as v`))!.v === null);
check("service_role_secret() is null before anything is stored",
  (await one<{ v: string | null }>(`select service_role_secret() as v`))!.v === null);
check("anthropic_key() is null before anything is stored",
  (await one<{ v: string | null }>(`select anthropic_key() as v`))!.v === null);

await db.query(`insert into app_settings (key, value) values ('service_role_key', $1), ('anthropic_api_key', $2)
  on conflict (key) do update set value = excluded.value`, [SERVICE, ANTHROPIC]);
check("service_role_secret() returns the stored service-role key",
  (await one<{ v: string }>(`select service_role_secret() as v`))!.v === SERVICE);
check("anthropic_key() returns the stored Anthropic key",
  (await one<{ v: string }>(`select anthropic_key() as v`))!.v === ANTHROPIC);
check("the mover left the rows alone (no vault to move them into)",
  Number((await one<{ n: number }>(`select count(*)::int as n from app_settings where key in ('service_role_key','anthropic_api_key')`))!.n) === 2);

console.log("\n2. who may call them");
for (const fn of ["service_role_secret", "anthropic_key"]) {
  for (const role of ["anon", "authenticated"]) {
    const r = await one<{ ok: boolean }>(`select has_function_privilege($1, $2, 'execute') as ok`, [role, `${fn}()`]);
    check(`${role} cannot execute ${fn}()`, r!.ok === false);
  }
  const r = await one<{ ok: boolean }>(`select has_function_privilege('service_role', $1, 'execute') as ok`, [`${fn}()`]);
  check(`service_role can execute ${fn}()`, r!.ok === true);
  const def = await one<{ secdef: boolean; vol: string }>(
    `select p.prosecdef as secdef, p.provolatile as vol from pg_proc p where p.proname = $1`, [fn]);
  check(`${fn}() is security definer`, def!.secdef === true);
  check(`${fn}() is stable`, def!.vol === "s", def!.vol);
}

console.log("\n3. the readers ask the accessor, not the table");
// The newest migration that schedules the sweeper, and the newest that
// defines kick_triage, are the ones in force. Both must be the vault
// migration or later, and neither body may read the key from app_settings.
const texts = new Map(migrations.map((f) => [f, readFileSync(join("supabase/migrations", f), "utf8")]));
const VAULT = "20260906160000_vault.sql";
const after = migrations.filter((f) => f >= "20260905080000");
const lastCron = after.filter((f) => /cron\.schedule\('proresponse-triage'/.test(texts.get(f)!)).at(-1);
const lastKick = after.filter((f) => /create or replace function kick_triage\(\)/.test(texts.get(f)!)).at(-1);
check("the sweeper in force is scheduled by the vault migration", lastCron === VAULT, String(lastCron));
check("the kick_triage in force is defined by the vault migration", lastKick === VAULT, String(lastKick));

const vault = texts.get(VAULT)!;
const job = /cron\.schedule\('proresponse-triage'[\s\S]*?\$job\$\)/.exec(vault)?.[0] ?? "";
const kick = /create or replace function kick_triage\(\)[\s\S]*?\n\$\$;/.exec(vault)?.[0] ?? "";
check("cron job body found", job.length > 0);
check("kick_triage body found", kick.length > 0);
check("cron job sends 'Bearer ' || service_role_secret()", /'Bearer ' \|\| service_role_secret\(\)/.test(job));
check("cron job does not read service_role_key from app_settings", !/service_role_key/.test(job));
check("kick_triage takes its bearer from service_role_secret()", /v_secret := service_role_secret\(\)/.test(kick));
check("kick_triage does not read service_role_key from app_settings", !/service_role_key/.test(kick));

// Within the vault migration, the only places allowed to name the key row in
// app_settings are the accessor and the mover. Everything else is a reader
// that should be asking the accessor.
const accessors = /create or replace function service_role_secret\(\)[\s\S]*?\n\$\$;[\s\S]*?create or replace function anthropic_key\(\)[\s\S]*?\n\$\$;/.exec(vault)?.[0] ?? "";
const mover = /-- 3\. The move\.[\s\S]*?end \$\$;/.exec(vault)?.[0] ?? "";
check("accessor block found", accessors.length > 0);
check("mover block found", mover.length > 0);
const elsewhere = vault.replace(accessors, "").replace(mover, "");
check("outside accessor and mover, the migration never selects a key from app_settings",
  !/from app_settings where key = '(service_role_key|anthropic_api_key)'/.test(elsewhere));

// Later migrations must not reintroduce a direct read in any function body.
const later = migrations.filter((f) => f > VAULT);
for (const f of later) {
  check(`${f} does not read a secret key from app_settings`,
    !/from app_settings where key = '(service_role_key|anthropic_api_key)'/.test(texts.get(f)!));
}
if (later.length === 0) console.log("  (no migration after the vault migration yet)");

console.log("\n4. the edge function asks the accessors");
const fn = readFileSync("supabase/functions/triage/index.ts", "utf8");
check("bearer gate calls rpc('service_role_secret')", /rpc\("service_role_secret"\)/.test(fn));
check("Anthropic key fallback calls rpc('anthropic_key')", /rpc\("anthropic_key"\)/.test(fn));
check("no direct read of service_role_key from app_settings", !/eq\("key", "service_role_key"\)/.test(fn));
check("no direct read of anthropic_api_key from app_settings", !/eq\("key", "anthropic_api_key"\)/.test(fn));

console.log("\n5. response headers in next.config.ts");
const cfg = readFileSync("next.config.ts", "utf8");
for (const name of [
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Permissions-Policy",
]) check(`${name} is set`, cfg.includes(`key: "${name}"`));
check("headers apply to every route", /source: "\/\(\.\*\)"/.test(cfg));
check("no Content-Security-Policy yet (a measured change, see the comment)", !/key: "Content-Security-Policy"/.test(cfg));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
