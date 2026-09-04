-- Tenant isolation. Written with the tables, not bolted on later.
-- Cross-club leakage is the one bug that ends the business.

-- Resolve the caller's club without recursing through profiles' own policies.
create or replace function auth_course_id()
returns uuid language sql stable security definer set search_path = public as $$
  select course_id from profiles where id = auth.uid() and active
$$;

create or replace function auth_role()
returns staff_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function auth_is_management()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('manager','owner') from profiles
                   where id = auth.uid() and active), false)
$$;

alter table courses            enable row level security;
alter table venues             enable row level security;
alter table locations          enable row level security;
alter table qr_codes           enable row level security;
alter table departments        enable row level security;
alter table profiles           enable row level security;
alter table pending_profiles   enable row level security;
alter table staff_departments  enable row level security;
alter table reports            enable row level security;
alter table report_events      enable row level security;
alter table routing_rules      enable row level security;
alter table triage_queue       enable row level security;
alter table notifications      enable row level security;
alter table push_subscriptions enable row level security;

-- Staff read everything inside their own club.
create policy staff_read on courses      for select to authenticated using (id = auth_course_id());
create policy staff_read on venues       for select to authenticated using (course_id = auth_course_id());
create policy staff_read on locations    for select to authenticated using (course_id = auth_course_id());
create policy staff_read on qr_codes     for select to authenticated using (course_id = auth_course_id());
create policy staff_read on departments  for select to authenticated using (course_id = auth_course_id());
create policy staff_read on profiles     for select to authenticated using (course_id = auth_course_id());
create policy staff_read on routing_rules for select to authenticated using (course_id = auth_course_id());
create policy staff_read on reports      for select to authenticated using (course_id = auth_course_id());
create policy staff_read on report_events for select to authenticated using (course_id = auth_course_id());
create policy staff_read on notifications for select to authenticated using (course_id = auth_course_id());

create policy staff_read on staff_departments for select to authenticated
  using (exists (select 1 from profiles p
                 where p.id = staff_departments.profile_id
                   and p.course_id = auth_course_id()));

-- Staff act on reports in their own club.
create policy staff_update on reports for update to authenticated
  using (course_id = auth_course_id()) with check (course_id = auth_course_id());

create policy staff_insert on reports for insert to authenticated
  with check (course_id = auth_course_id());

create policy staff_append on report_events for insert to authenticated
  with check (course_id = auth_course_id());

-- Own duty status / own push subscriptions.
create policy self_update on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy own_subs on push_subscriptions for all to authenticated
  using (exists (select 1 from profiles p where p.id = push_subscriptions.profile_id
                   and p.course_id = auth_course_id()))
  with check (exists (select 1 from profiles p where p.id = push_subscriptions.profile_id
                        and p.course_id = auth_course_id()));

-- Management-only configuration.
create policy mgmt_write on locations     for all to authenticated
  using (course_id = auth_course_id() and auth_is_management())
  with check (course_id = auth_course_id() and auth_is_management());
create policy mgmt_write on departments   for all to authenticated
  using (course_id = auth_course_id() and auth_is_management())
  with check (course_id = auth_course_id() and auth_is_management());
create policy mgmt_write on routing_rules for all to authenticated
  using (course_id = auth_course_id() and auth_is_management())
  with check (course_id = auth_course_id() and auth_is_management());
create policy mgmt_write on pending_profiles for all to authenticated
  using (course_id = auth_course_id() and auth_is_management())
  with check (course_id = auth_course_id() and auth_is_management());
create policy mgmt_write on qr_codes for all to authenticated
  using (course_id = auth_course_id() and auth_is_management())
  with check (course_id = auth_course_id() and auth_is_management());
create policy mgmt_write on venues for all to authenticated
  using (course_id = auth_course_id() and auth_is_management())
  with check (course_id = auth_course_id() and auth_is_management());

-- triage_queue is service-role only: no policies, RLS on, so PostgREST sees nothing.

-- Members: NO direct table access at all. They reach the database only through
-- the submit_report and get_report_status functions in the next migration.
