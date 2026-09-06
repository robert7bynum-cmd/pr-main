-- The accountability record could be rewritten by anyone it was about.
--
-- Found by asking the live database, then reproduced offline: `authenticated`
-- holds INSERT, UPDATE and DELETE on most tables (Supabase's defaults, which
-- 20260905180000 stopped for NEW tables but left in place on the existing
-- ones), and four policies from 20260903120200 opened those grants to every
-- signed-in staff member through PostgREST:
--
--   staff_update on reports        — UPDATE any column where course_id matches.
--                                    So `resolved_by`, `acknowledged_at`,
--                                    `status`, `claimed_by`: set directly,
--                                    no assert_actor, no report_events row.
--   staff_insert on reports        — a report that no member ever submitted.
--   staff_append on report_events  — INSERT with any actor_id. Every number
--                                    on the GM's screen derives from this
--                                    table (CLAUDE.md, Processing integrity),
--                                    so this is "write your own metrics".
--   mgmt_write   on routing_rules  — ALL, bypassing update_routing_rules()'s
--                                    SLA bounds and its admin_events row.
--
-- and own_subs on push_subscriptions was written as "any profile in the club",
-- which let a staff member delete a manager's device or register their own
-- phone under the manager's profile_id — and so receive the manager's pages.
--
-- None of it was used. No code in app/, lib/ or components/ writes reports,
-- report_events or routing_rules directly; every mutation goes through a
-- SECURITY DEFINER function that checks the caller and writes the event. The
-- policies were the intent from the first day, before the functions existed,
-- and nobody went back to remove them once the functions did.
--
-- The rule is the one this repo keeps relearning: grants and RLS are two
-- independent lines of defence and both must hold. Here BOTH were open. So
-- both are closed — the policies go, and the write privileges go with them, so
-- that a policy added later by someone who has not read this file does not
-- silently reopen the table. Reads are untouched: staff_read stays on every
-- table it was on, and SELECT is not revoked anywhere.

-- 1. Policies that granted direct writes on tables that only functions write.
drop policy if exists staff_update on reports;
drop policy if exists staff_insert on reports;
drop policy if exists staff_append on report_events;
drop policy if exists mgmt_write   on routing_rules;

-- 2. A push subscription is yours or it is not your business. The row filter
--    and the check both say auth.uid() — wrapped in a subselect so the planner
--    evaluates it once per statement rather than once per row.
--    savePushSubscription() in app/actions/push.ts upserts with
--    profile_id = the signed-in user and onConflict endpoint, which is exactly
--    the row this admits; nothing else in the app writes this table as a user.
drop policy if exists own_subs on push_subscriptions;
create policy own_subs on push_subscriptions for all to authenticated
  using      (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- 3. Revoke the write privileges themselves on every table that, after the
--    drops above, has no policy that would let `authenticated` write it. With
--    RLS on and no write policy these were already refused — which is exactly
--    why it is worth doing now: the grant is the second line, and today it is
--    the only one that would hold if a policy were added.
--
--    Guarded with to_regclass, as 20260905180000 is, so a table absent from
--    one environment cannot make the whole migration fail half way — and so
--    the same file runs identically offline and on Supabase.
--
--    Deliberately NOT in this list, and why:
--      profiles           — 20260906030000 already replaced the table grant
--                           with column grants (full_name, phone,
--                           preferred_language, on_duty). Touching it here
--                           would undo that.
--      push_subscriptions — the own-row policy above is the legitimate write
--                           path for savePushSubscription(); the grant stays.
--      locations, departments, qr_codes, venues, pending_profiles
--                         — mgmt_write is still their only write path; there
--                           is no RPC for them yet. Revoking would break
--                           management configuration with nothing to replace
--                           it. They are the next thing to move behind
--                           functions, not a thing to break today.
--      staff_invites      — already fully revoked in 20260906050000.
--      the six service-role tables — already revoked in 20260905180000.
do $$
declare t text;
begin
  foreach t in array array[
    'reports', 'report_events', 'routing_rules',
    'admin_events', 'notifications',
    'system_alerts', 'system_heartbeats',
    'triage_keywords', 'staff_departments', 'courses'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format(
        'revoke insert, update, delete, truncate, trigger, references on public.%I from authenticated', t);
    end if;
  end loop;
end $$;

-- anon already holds nothing (20260905090000); service_role is unchanged.
