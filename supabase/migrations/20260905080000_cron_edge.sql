-- Point the triage sweeper at the edge function instead of the web app.
--
-- Triage no longer depends on Vercel existing, on a deployment URL being
-- configured, or on the web host being up. The function lives beside the
-- database and has a stable address from the moment the project exists.
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
        'Authorization', 'Bearer ' || (select value from app_settings where key = 'service_role_key')),
      body    := '{}'::jsonb
    )
    where exists (select 1 from app_settings where key = 'triage_function_url')
      and exists (select 1 from triage_queue
                   where status = 'pending' and next_attempt_at <= now())
  $job$);
end $$;
