-- CRITICAL: make views respect the caller's RLS.
--
-- A Postgres view runs with its owner's privileges by default, so RLS on the
-- underlying tables is bypassed for anyone who can select from the view. Every
-- view here was fully readable by an anonymous caller holding the publishable
-- key — which ships in the client bundle and is therefore public. That exposed
-- open reports, member wording, staff names and per-person performance data for
-- every club.
--
-- security_invoker makes the view execute as the caller, so the same policies
-- that protect reports and profiles protect these too.
alter view staff_queue                set (security_invoker = on);
alter view dashboard_today            set (security_invoker = on);
alter view dashboard_daily            set (security_invoker = on);
alter view dashboard_by_department    set (security_invoker = on);
alter view dashboard_recurring        set (security_invoker = on);
alter view dashboard_by_person        set (security_invoker = on);
