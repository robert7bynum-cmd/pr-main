-- Reports, the event trail, and the durable work queue that guarantees triage.

create type report_status as enum (
  'new','triaged','acknowledged','in_progress','scheduled',
  'resolved','verified','reopened','closed_no_action'
);
create type report_urgency  as enum ('low','normal','high','urgent');
create type report_source   as enum ('member_qr','staff','phone_relay');
create type triage_source   as enum ('keyword','model','manual');
create type close_reason    as enum ('invalid','duplicate','no_action_needed');

create table reports (
  id                    uuid primary key default gen_random_uuid(),
  course_id             uuid not null references courses(id) on delete cascade,
  location_id           uuid not null references locations(id),
  qr_code_id            uuid references qr_codes(id),

  -- what the filer actually said. written once, never mutated.
  body                  text not null,
  ai_summary            text,
  photo_path            text,

  source                report_source not null default 'member_qr',
  filed_by              uuid references profiles(id),

  -- the member's only route back to their report
  tracking_token        text not null unique default encode(gen_random_bytes(16), 'hex'),
  reporter_name         text,
  reporter_phone        text,
  reporter_member_no    text,
  reporter_language     text not null default 'en',
  sms_opt_in            boolean not null default false,

  -- triage
  category              text,
  urgency               report_urgency not null default 'normal',
  ai_confidence         numeric(3,2),
  ai_raw                jsonb,
  triage_source         triage_source,
  department_id         uuid references departments(id),

  -- ownership and lifecycle
  status                report_status not null default 'new',
  claimed_by            uuid references profiles(id),
  claimed_at            timestamptz,
  scheduled_for         date,
  escalation_level      int not null default 0,

  acknowledged_at       timestamptz,
  resolved_at           timestamptz,
  resolved_by           uuid references profiles(id),
  resolution_note       text,          -- INTERNAL. never shown to a member.
  resolution_photo_path text,          -- optional, never required
  close_reason          close_reason,

  -- what the member sees, chosen deliberately by staff
  member_message        text,
  member_notified_at    timestamptz,

  duplicate_of_id       uuid references reports(id),
  reopened_from_id      uuid references reports(id),
  reopen_count          int not null default 0,

  -- reserved: only if a club's reopen rate warrants the extra friction
  resolved_on_site      boolean,
  verified_by           uuid references profiles(id),
  verified_at           timestamptz,

  created_at            timestamptz not null default now()
);
create index on reports (course_id, status);
create index on reports (course_id, created_at desc);
create index on reports (department_id, status);
create index on reports (location_id, category, created_at desc);
create index on reports (tracking_token);

comment on column reports.body is
  'The filer''s verbatim submission. Written once; AI writes ai_summary instead.';
comment on column reports.resolution_note is
  'Internal only. The member-facing text is member_message.';

-- The spine of every metric and accountability claim.
create type report_event_type as enum (
  'created','triaged','routed','notified','acknowledged','scheduled',
  'escalated','unstaffed','reassigned','note','resolved','verified',
  'reopened','member_notified'
);

create table report_events (
  id          bigserial primary key,
  report_id   uuid not null references reports(id) on delete cascade,
  course_id   uuid not null references courses(id) on delete cascade,
  type        report_event_type not null,
  actor_id    uuid references profiles(id),
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index on report_events (report_id, created_at);
create index on report_events (course_id, type, created_at desc);

-- ------------------------------------------------------------ routing
create table routing_rules (
  id                  uuid primary key default gen_random_uuid(),
  course_id           uuid not null references courses(id) on delete cascade,
  category            text not null,
  department_id       uuid not null references departments(id) on delete cascade,
  ack_sla_minutes     int not null default 15,
  resolve_sla_minutes int not null default 120,
  escalation_chain    jsonb not null default '[]'::jsonb,
  requires_photo      boolean not null default false,
  source_document_id  uuid,
  source_excerpt      text,
  unique (course_id, category)
);

-- --------------------------------------------------- durable triage queue
-- Written in the SAME transaction as the report. The DB webhook is only a fast
-- path; this table plus the pg_cron sweeper is what guarantees delivery.
create type queue_status as enum ('pending','processing','done','dead_letter');

create table triage_queue (
  report_id       uuid primary key references reports(id) on delete cascade,
  status          queue_status not null default 'pending',
  attempts        int not null default 0,
  locked_at       timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now()
);
create index on triage_queue (status, next_attempt_at);

-- ------------------------------------------------------- notifications
create type notify_channel as enum ('push','sms','station','email');
create type notify_status  as enum ('queued','sent','delivered','failed');

create table notifications (
  id              uuid primary key default gen_random_uuid(),
  report_id       uuid not null references reports(id) on delete cascade,
  course_id       uuid not null references courses(id) on delete cascade,
  profile_id      uuid references profiles(id) on delete cascade,
  channel         notify_channel not null,
  status          notify_status not null default 'queued',
  attempt         int not null default 0,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  failed_at       timestamptz,
  next_retry_at   timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);
create index on notifications (report_id);
create index on notifications (status, next_retry_at);

create table push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references profiles(id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  last_success_at timestamptz,
  failure_count   int not null default 0,
  created_at      timestamptz not null default now()
);
create index on push_subscriptions (profile_id);
