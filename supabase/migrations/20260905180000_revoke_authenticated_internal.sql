-- Finish the lockdown that 20260905090000 started.
--
-- That migration revoked every table privilege from `anon`, because Supabase
-- grants full CRUD by default and RLS was the only thing standing in the way.
-- It stopped there. `authenticated` still held DELETE, INSERT, SELECT, TRIGGER,
-- TRUNCATE and UPDATE on six tables that exist purely for the service role:
--
--   app_settings          — holds the service role key and the Anthropic key
--   scan_nonces           — the anti-scripting control for member submissions
--   schema_migrations     — what has been applied
--   triage_queue          — the work queue
--   triage_misspellings   — matcher data
--   triage_safety_idioms  — matcher data
--
-- Nothing leaks today: all six have RLS on with zero policies, which denies
-- everything to a role that does not bypass RLS. That is precisely why it is
-- worth fixing now rather than after something goes wrong. The rule in this
-- repo is that grants and RLS are two independent lines of defence and both
-- must hold; here only one was holding, and the failure mode if it stopped is
-- that every signed-in staff member can read the service role key out of
-- app_settings — which is unrestricted access to the entire database,
-- including every other club's data once there is more than one.
--
-- One accidental `disable row level security`, or one permissive policy added
-- to app_settings by someone who has not read this file, is the whole distance
-- between today and that outcome.
--
-- Safe to revoke: no view reads these tables (checked against pg_depend), and
-- every function that touches them is SECURITY DEFINER, so it runs as the
-- owner rather than as the caller.

-- Guarded per table: schema_migrations is created by the migration runner
-- rather than by a migration, so it is absent in the offline test harness.
-- A revoke that only runs on Supabase is worse than useless — it would pass
-- locally and be the one line nobody had ever executed.
do $$
declare t text;
begin
  foreach t in array array[
    'app_settings', 'scan_nonces', 'schema_migrations',
    'triage_queue', 'triage_misspellings', 'triage_safety_idioms'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
end $$;

-- And keep it that way. Supabase's default grants apply to newly created
-- tables, so the next internal table would arrive with the same problem.
--
-- This makes a new table deny-by-default for signed-in users too, which means
-- a table that genuinely should be staff-readable now needs an explicit grant
-- alongside its RLS policy. That is the intended cost: the repo already
-- requires every new table to enable RLS in the migration that creates it, and
-- an explicit grant is the other half of the same sentence.
alter default privileges in schema public revoke all on tables from authenticated;
