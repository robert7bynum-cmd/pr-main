-- Defence in depth on the RPC surface.
--
-- claim_profile and me already returned nothing to an anonymous caller, because
-- both key off auth.uid(). But Postgres grants EXECUTE to PUBLIC by default, so
-- they were still callable — an audit found both answering 200 to anon. A
-- function that can only ever return nothing should not be reachable at all.
revoke execute on function claim_profile() from public, anon;
revoke execute on function me()            from public, anon;
grant  execute on function claim_profile() to authenticated;
grant  execute on function me()            to authenticated;

-- The staff action functions are called through the app with a session; none
-- should be reachable without one.
do $$
declare f text;
begin
  foreach f in array array[
    'acknowledge_report(uuid,uuid)', 'start_report(uuid,uuid)',
    'resolve_report(uuid,uuid,text,text)', 'schedule_report(uuid,uuid,date,text)',
    'reroute_report(uuid,uuid,uuid)', 'close_no_action(uuid,uuid,close_reason)',
    'resolve_recipients(uuid,uuid)',
    'route_report(uuid,text,report_urgency,text,numeric,triage_source)',
    'claim_triage_batch(int)', 'fail_triage(uuid,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
  end loop;
end $$;
