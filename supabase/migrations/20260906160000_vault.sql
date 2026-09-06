-- Two secrets sat in a table in plaintext, and every reader of that table
-- could copy them.
--
-- app_settings has held the service-role key since 20260905080000, so that
-- pg_cron could send it as the bearer when it calls the edge function, and
-- the Anthropic key since the worker moved into Supabase, so the function
-- could find it without anyone running the CLI. Both were the right shape for
-- the caller and the wrong shape for a secret: a plain text column, readable
-- by anything that can read the table, showing up whole in a `select *`, in a
-- dump, in a support screenshot. Three audits flagged it. The service-role key
-- in particular is the whole database.
--
-- Supabase Vault is the platform's answer: `vault.create_secret` stores a
-- value encrypted at rest under a key the database never exposes, and
-- `vault.decrypted_secrets` decrypts on read for a caller allowed to see it.
-- The two values move there, and the two readers stop reading app_settings
-- and ask a function instead.
--
-- ONE IMPLEMENTATION, TWO STORES, THE VAULT WINS. service_role_secret() and
-- anthropic_key() are the only places that know where a secret lives. Each
-- answers from the vault when it is installed and holds the secret, and from
-- app_settings otherwise — so PGlite, which has no vault, keeps every offline
-- suite running, and a project that has not been migrated yet keeps triaging
-- until it is. Nothing else may read either key by name; scripts/test-secrets
-- reads the migration text to make sure nothing does.
--
-- WHO CAN CALL THEM. Both functions are SECURITY DEFINER, owned by the role
-- that runs migrations (postgres), which is also the owner of every pg_cron
-- job — so the job and the trigger execute them as their owner without any
-- grant at all. The edge function calls anthropic_key() through PostgREST
-- holding the service-role key, which is the one grant made here. anon and
-- authenticated are revoked outright: a staff session must not be able to ask
-- the database for its own master key.
--
-- THE MOVE. When the vault is present, each value is copied from app_settings
-- into it with `vault.create_secret` and the row is deleted, in one
-- transaction, inside the database. The value never leaves the database: no
-- script reads it, no transcript prints it, no environment variable carries
-- it. If a secret of that name is already in the vault the row is deleted
-- without overwriting — the vault is authoritative from the moment it holds a
-- value. Re-running the migration is a no-op.
--
-- Everything is guarded: without pg_available_extensions listing
-- supabase_vault (any local Postgres, PGlite) the extension step and the move
-- are skipped with a notice, and the accessors fall through to app_settings.
-- Without pg_cron the re-schedule is skipped exactly as every migration
-- before it has done.

-- 1. The extension, where the platform offers it.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
    raise notice 'supabase_vault unavailable — secrets stay in app_settings (not a Supabase database)';
    return;
  end if;
  create extension if not exists supabase_vault;
end $$;

-- 2. The accessors. `to_regclass` is evaluated at run time, so the vault
-- branch is never reached — and never resolved — on a database without one.
create or replace function service_role_secret()
returns text
language plpgsql stable security definer set search_path = public, vault as $$
declare
  v text;
begin
  if to_regclass('vault.decrypted_secrets') is not null then
    select decrypted_secret into v
      from vault.decrypted_secrets where name = 'service_role_key' limit 1;
    if v is not null then
      return v;
    end if;
  end if;
  select value into v from app_settings where key = 'service_role_key';
  return v;
end;
$$;

create or replace function anthropic_key()
returns text
language plpgsql stable security definer set search_path = public, vault as $$
declare
  v text;
begin
  if to_regclass('vault.decrypted_secrets') is not null then
    select decrypted_secret into v
      from vault.decrypted_secrets where name = 'anthropic_api_key' limit 1;
    if v is not null then
      return v;
    end if;
  end if;
  select value into v from app_settings where key = 'anthropic_api_key';
  return v;
end;
$$;

comment on function service_role_secret() is
  'The service-role key the database sends when it calls its own edge function. '
  'One implementation, two stores: the vault when installed, app_settings otherwise; the vault wins. '
  'Callable by the job owner and the service role only.';
comment on function anthropic_key() is
  'The Anthropic API key the triage worker classifies with. '
  'One implementation, two stores: the vault when installed, app_settings otherwise; the vault wins. '
  'Callable by the job owner and the service role only.';

revoke all on function service_role_secret() from public, anon, authenticated;
grant execute on function service_role_secret() to service_role;
revoke all on function anthropic_key() from public, anon, authenticated;
grant execute on function anthropic_key() to service_role;

-- 3. The move. Inside the database, in this transaction; the value is never
-- selected out to anything that could print it.
do $$
declare
  k text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise notice 'no vault — service_role_key and anthropic_api_key stay in app_settings';
    return;
  end if;

  foreach k in array array['service_role_key', 'anthropic_api_key'] loop
    if exists (select 1 from app_settings where key = k) then
      if not exists (select 1 from vault.secrets where name = k) then
        perform vault.create_secret((select value from app_settings where key = k), k);
        raise notice '% moved from app_settings into the vault', k;
      else
        raise notice '% already in the vault; app_settings copy dropped', k;
      end if;
      delete from app_settings where key = k;
    end if;
  end loop;
end $$;

-- 4. The readers. The sweeper, exactly as 20260906090000 scheduled it, with
-- the bearer coming from the accessor. triage_function_url stays in
-- app_settings: it is an address, not a secret.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — skipping (not a Supabase database)';
    return;
  end if;

  perform cron.unschedule('proresponse-triage')
    where exists (select 1 from cron.job where jobname = 'proresponse-triage');

  perform cron.schedule('proresponse-triage', '* * * * *', $job$
    select net.http_post(
      url     := (select value from app_settings where key = 'triage_function_url'),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || service_role_secret()),
      body    := '{}'::jsonb
    )
    where exists (select 1 from app_settings where key = 'triage_function_url')
      and (
        exists (select 1 from triage_queue
                 where status = 'pending' and next_attempt_at <= now())
        -- Escalation queues notifications without touching triage_queue. A
        -- notification waiting out a retry backoff is still 'queued' and is
        -- not a reason to call the worker until its retry is due.
        or exists (select 1 from notifications
                    where status = 'queued'
                      and (next_retry_at is null or next_retry_at <= now()))
      )
  $job$);
end $$;

-- The fast path, as 20260906020000 wrote it, asking the accessor for the
-- bearer. Same guards: no worker configured or no pg_net means a notice and
-- the cron sweeps.
create or replace function kick_triage()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url from app_settings where key = 'triage_function_url';
  v_secret := service_role_secret();

  if v_url is null or v_secret is null then
    raise notice 'kick_triage: no worker configured; the cron will sweep';
    return null;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    raise notice 'kick_triage: pg_net not installed; the cron will sweep';
    return null;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_secret),
    body    := '{}'::jsonb
  );
  return null;
end;
$$;

-- Restated beside the definition, as 20260906090000 does for escalate_reports:
-- the trigger function is called by the database, never by a role.
revoke all on function kick_triage() from public, anon, authenticated;

drop trigger if exists triage_queue_kick on triage_queue;
create trigger triage_queue_kick
  after insert on triage_queue
  for each statement
  execute function kick_triage();

drop trigger if exists notifications_kick on notifications;
create trigger notifications_kick
  after insert on notifications
  for each statement
  execute function kick_triage();
