-- Configuration changes are recorded, the way report actions already are.
--
-- report_events made every operational decision traceable; nothing did the same
-- for administrative ones. Who added this person, who gave them supervisor,
-- who changed the escalation SLA, who deactivated someone the week a dispute
-- started — all of it was invisible. Building the admin surface is the moment
-- to fix that, not after a club asks.

create type admin_event_type as enum (
  'staff_invited', 'staff_activated', 'staff_deactivated',
  'staff_role_changed', 'staff_departments_changed', 'staff_password_reset',
  'routing_rule_changed', 'location_changed', 'placard_regenerated',
  'settings_changed'
);

create table admin_events (
  id         bigserial primary key,
  course_id  uuid not null references courses(id) on delete cascade,
  actor_id   uuid references profiles(id),
  type       admin_event_type not null,
  subject_id uuid,                       -- the staff member / rule acted upon
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on admin_events (course_id, created_at desc);
create index on admin_events (subject_id, created_at desc);

alter table admin_events enable row level security;

-- Management can read their own club's admin history. Nobody writes directly;
-- entries are only made by the definer functions below, so the log cannot be
-- edited by the person it is recording.
create policy mgmt_read on admin_events for select to authenticated
  using (course_id = auth_course_id() and auth_is_management());

revoke all on admin_events from anon;

-- Internal helper: every admin function records through this.
create or replace function log_admin_event(
  p_course_id uuid, p_actor uuid, p_type admin_event_type,
  p_subject uuid default null, p_detail jsonb default '{}'::jsonb
) returns void
language sql volatile security definer set search_path = public as $$
  insert into admin_events (course_id, actor_id, type, subject_id, detail)
  values (p_course_id, p_actor, p_type, p_subject, p_detail);
$$;

revoke execute on function log_admin_event(uuid,uuid,admin_event_type,uuid,jsonb)
  from public, anon, authenticated;
