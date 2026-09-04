-- Making the system run without anyone invoking it.
--
-- Escalation is pure SQL, so cron calls it directly and it keeps working even
-- if the web app is down. Triage needs the app (the model call lives there), so
-- cron POSTs to it — the fast path is still the insert webhook, this is the
-- guarantee behind it.
--
-- Guarded throughout: the local test harness runs plain Postgres with neither
-- extension, and an unguarded CREATE EXTENSION here would take every SQL suite
-- down, which has already happened once.

create table if not exists app_settings (
  key   text primary key,
  value text not null
);
alter table app_settings enable row level security;  -- service role only

comment on table app_settings is
  'Deployment configuration the database needs, e.g. where to reach the worker.';

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — skipping schedules (not a Supabase database)';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  -- Escalation: every minute, straight into the function.
  perform cron.unschedule('proresponse-escalate')
    where exists (select 1 from cron.job where jobname = 'proresponse-escalate');
  perform cron.schedule('proresponse-escalate', '* * * * *',
    $job$ select escalate_reports() $job$);

  -- Triage sweeper: every minute, POST to the app. Does nothing until the
  -- worker URL and secret are set, so a fresh database is not calling a
  -- non-existent endpoint every minute.
  perform cron.unschedule('proresponse-triage')
    where exists (select 1 from cron.job where jobname = 'proresponse-triage');
  perform cron.schedule('proresponse-triage', '* * * * *', $job$
    select net.http_post(
      url     := (select value from app_settings where key = 'worker_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select value from app_settings where key = 'worker_secret')),
      body    := '{}'::jsonb
    )
    where exists (select 1 from app_settings where key = 'worker_url')
      and exists (select 1 from triage_queue where status = 'pending')
  $job$);
end $$;
