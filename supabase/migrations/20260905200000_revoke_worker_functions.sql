-- The worker's functions belong to the worker.
--
-- Supabase's database linter surfaced these, and checking the call sites made
-- the problem concrete: route_report, resolve_recipients, claim_triage_batch,
-- complete_triage, fail_triage, escalate_reports, match_keywords and
-- within_quiet_hours have zero call sites anywhere in app/, lib/ or
-- components/. Every one of them is invoked by the triage edge function using
-- the service role, or by pg_cron as the owner. None is part of the signed-in
-- staff API.
--
-- They were nonetheless executable by `authenticated` — meaning any staff
-- member with a valid session, a groundskeeper included, could:
--
--   route_report        reroute any report to any department with any urgency,
--                       bypassing both the classifier and routing_rules
--   claim_triage_batch  claim the pending queue and simply not process it,
--                       stalling triage for the whole club while every screen
--                       continued to look healthy
--   escalate_reports    page leadership at will
--   resolve_recipients  enumerate exactly who gets woken for a department
--
-- None of that requires malice to cause damage; a curious person with the
-- network tab open is enough. This repo's rule already covers it — "a function
-- that can only return nothing should not be callable", and every function is
-- revoked from public and anon then granted explicitly — but that rule was
-- applied to the member-facing surface and these worker functions were never
-- brought under it.
--
-- Granted explicitly to service_role rather than left implicit, so the grant
-- states who the caller is meant to be. The owner keeps EXECUTE regardless,
-- which is what lets pg_cron continue to run escalation.
--
-- Deliberately NOT touched: get_scan_context, issue_scan_nonce and
-- submit_report remain executable by anon. That is the member path — a person
-- with no account scanning a placard — and the linter flagging them is the
-- linter not knowing what this product is.

do $$
declare
  fn text;
  sig text;
begin
  foreach fn in array array[
    'route_report', 'resolve_recipients', 'claim_triage_batch',
    'complete_triage', 'fail_triage', 'escalate_reports',
    'match_keywords', 'within_quiet_hours'
  ] loop
    -- Signature-qualified: several of these are overloaded or take enum types,
    -- and a bare name would not resolve.
    for sig in
      select p.oid::regprocedure::text
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = fn
    loop
      execute format('revoke all on function %s from public, anon, authenticated', sig);
      execute format('grant execute on function %s to service_role', sig);
    end loop;
  end loop;
end $$;
