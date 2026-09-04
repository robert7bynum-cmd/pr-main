-- ProResponse core tenancy: clubs, venues, locations, QR codes, departments, people.
-- Every domain table carries course_id. RLS lives in a later migration but the
-- columns it depends on are established here.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- clubs
create table courses (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  timezone      text not null default 'America/New_York',
  is_demo       boolean not null default false,
  -- branding (logo_url, colors, fonts), quiet_hours, domain
  settings      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

comment on column courses.is_demo is
  'Demo clubs are excluded from billing and cross-club reporting.';

-- A property can have more than one course or clubhouse.
create table venues (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references courses(id) on delete cascade,
  name          text not null,
  sort_order    int  not null default 0
);
create index on venues (course_id);

-- Not just holes: restrooms, the range and the clubhouse all generate reports.
create type location_kind as enum
  ('hole','practice','clubhouse','cart_barn','restroom','halfway_house','other');

create table locations (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references courses(id) on delete cascade,
  venue_id      uuid references venues(id) on delete set null,
  kind          location_kind not null default 'hole',
  hole_number   int,
  name          text not null,
  geo           point,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
create index on locations (course_id);
create unique index on locations (course_id, hole_number) where hole_number is not null;

-- One placard = one token. Tokens are revocable per location without reprinting
-- the whole course.
create table qr_codes (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references courses(id) on delete cascade,
  location_id   uuid not null references locations(id) on delete cascade,
  token         text not null unique default encode(gen_random_bytes(12), 'hex'),
  active        boolean not null default true,
  printed_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index on qr_codes (course_id);
create index on qr_codes (token) where active;

-- ---------------------------------------------------------- departments
create table departments (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references courses(id) on delete cascade,
  key           text not null,
  name          text not null,
  sort_order    int  not null default 0,
  unique (course_id, key)
);

-- ---------------------------------------------------------------- people
create type staff_role   as enum ('staff','supervisor','manager','owner');
create type account_kind as enum ('individual','station');

create table profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  course_id          uuid not null references courses(id) on delete cascade,
  full_name          text not null,
  email              text,
  phone              text,
  role               staff_role   not null default 'staff',
  account_kind       account_kind not null default 'individual',
  preferred_language text not null default 'en',
  on_duty            boolean not null default false,
  on_duty_since      timestamptz,
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);
create index on profiles (course_id);
create index on profiles (course_id, on_duty) where active;

comment on column profiles.account_kind is
  'Station accounts are shared counter logins and are excluded from per-person metrics.';

-- Admin creates the profile before the person ever signs in; this row is claimed
-- by email on first magic-link login.
create table pending_profiles (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references courses(id) on delete cascade,
  email         text not null,
  full_name     text not null,
  phone         text,
  role          staff_role not null default 'staff',
  department_ids uuid[] not null default '{}',
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  unique (course_id, email)
);

create table staff_departments (
  profile_id    uuid not null references profiles(id) on delete cascade,
  department_id uuid not null references departments(id) on delete cascade,
  primary key (profile_id, department_id)
);
