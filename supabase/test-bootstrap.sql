-- Minimal stand-in for the parts of Supabase that a plain Postgres lacks, so
-- migrations and seed can be exercised locally without Docker or a network.
--
-- Single source of truth on purpose: this used to be copy-pasted into five test
-- scripts and lib/dev-db.ts, and drifted — hardening the seed's auth.users
-- insert broke every local suite because the stub was missing the new columns.

create role anon;
create role authenticated;
create role service_role;

create schema if not exists auth;

create table auth.users (
  id                         uuid primary key,
  instance_id                uuid,
  email                      text,
  aud                        text,
  role                       text,
  email_confirmed_at         timestamptz,
  confirmation_token         text,
  recovery_token             text,
  email_change_token_new     text,
  email_change               text,
  email_change_token_current text,
  phone_change               text,
  phone_change_token         text,
  reauthentication_token     text,
  created_at                 timestamptz default now(),
  updated_at                 timestamptz default now()
);

-- Impersonation for tests: auth.uid() reads a session setting so a suite can
-- act as a specific staff member and exercise the privilege guards, which is
-- the only way to test them at all.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
