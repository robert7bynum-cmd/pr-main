-- A phone that is not a browser has nowhere to register.
--
-- Push delivery is web-push only: push_subscriptions holds an endpoint and the
-- p256dh/auth pair a browser hands out, and the worker speaks VAPID to it. An
-- iOS or Android app does not have any of that. It has a device token minted
-- by APNs or FCM, and the only thing to do with one is post it to Apple or
-- Google — a different table shape, a different transport, a different way of
-- learning the device is gone.
--
-- So native devices get their own table rather than a nullable column bolted
-- onto push_subscriptions, and the worker sends to both. A person with a
-- browser tab and a phone is paged on both; delivery to either counts as
-- delivered, exactly as it does across two browsers today.
--
-- The access posture is the one this repo keeps relearning, stated in full:
--
--   * RLS on in the same statement block that creates the table.
--   * anon holds nothing. 20260905090000 revoked anon from every table then,
--     and the default privileges in 20260905180000 revoke `authenticated` from
--     every table created since — so the explicit grant below is not
--     housekeeping, it is the only reason a signed-in person can reach the
--     table at all. Grants and RLS are two lines of defence, and both must
--     hold: the policy says "your own rows", the grant says "and only these
--     four operations".
--   * The policy is own-row, written exactly as own_subs on push_subscriptions
--     was rewritten in 20260906070000: profile_id = (select auth.uid()) on
--     both the filter and the check, so a staff member cannot register their
--     phone under a manager's id and receive the manager's pages.
--
-- The RPCs exist so the apps never write the table by hand. register_device
-- upserts on the token — a reinstalled app gets the same token back and must
-- not end up with two rows — and resets failure_count, because a token the
-- app has just presented is one the app believes in. unregister_device is a
-- sign-out: it deletes the caller's row only, and says whether it found one,
-- because a sign-out that silently did nothing is the kind of silence this
-- repo does not accept as success.
--
-- set_staff_active(false) drops these the way it drops push_subscriptions
-- (20260906030000): a departed employee's phone must stop buzzing, and the
-- audit row's devices_removed counts both kinds together, since "how many
-- devices were cut off" is the question it answers.

create table if not exists device_tokens (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references profiles(id) on delete cascade,
  platform      text not null check (platform in ('ios', 'android')),
  token         text not null unique,
  app_version   text,
  last_seen_at  timestamptz not null default now(),
  failure_count int not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists device_tokens_profile_id_idx on device_tokens (profile_id);

alter table device_tokens enable row level security;

-- anon is already denied by 20260905090000's revoke and the default privileges
-- since; restated so this file is the whole posture of the table on its own.
revoke all on device_tokens from anon;

drop policy if exists own_devices on device_tokens;
create policy own_devices on device_tokens for all to authenticated
  using      (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- Default privileges deny `authenticated` everything on a new table
-- (20260905180000). This grant is the second half of the policy above: without
-- it the app's own-row upsert is "permission denied" before RLS is consulted.
grant select, insert, update, delete on device_tokens to authenticated;

/**
 * Register (or refresh) the calling person's native device.
 *
 * Upserts on the token: the same device presenting the same token is one row,
 * whoever it last belonged to — a phone handed from one staff member to
 * another re-registers under the new signer-in, which is the right answer.
 * last_seen_at is refreshed and failure_count reset on every call, so a token
 * the worker had been counting down can be rehabilitated by the app simply
 * showing up.
 */
create or replace function register_device(p_platform text, p_token text, p_app_version text default null)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'platform must be ios or android' using errcode = '22023';
  end if;
  if p_token is null or length(btrim(p_token)) = 0 then
    raise exception 'a device token is required' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles where id = v_uid and active) then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  insert into device_tokens (profile_id, platform, token, app_version)
  values (v_uid, p_platform, btrim(p_token), nullif(btrim(coalesce(p_app_version, '')), ''))
  on conflict (token) do update
    set profile_id    = excluded.profile_id,
        platform      = excluded.platform,
        app_version   = excluded.app_version,
        last_seen_at  = now(),
        failure_count = 0
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function register_device(text, text, text) from public, anon;
grant execute on function register_device(text, text, text) to authenticated;

/**
 * Forget a native device on sign-out.
 *
 * Only the caller's own row: another person's token is invisible here, and the
 * function answers false rather than pretending. True means a row was removed.
 */
create or replace function unregister_device(p_token text)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  delete from device_tokens where token = p_token and profile_id = v_uid;
  return found;
end;
$$;

revoke all on function unregister_device(text) from public, anon;
grant execute on function unregister_device(text) to authenticated;

/**
 * Offboarding that actually ends access — 20260906030000, with native devices.
 *
 * Restated in full rather than patched, so the function reads as one thing.
 * The only change from 20260906030000 is that device_tokens are deleted beside
 * push_subscriptions, and devices_removed in the audit row counts both.
 */
create or replace function set_staff_active(p_profile_id uuid, p_active boolean)
returns void language plpgsql volatile security definer set search_path = public as $$
declare g record; v_target profiles%rowtype; v_sessions int := 0; v_devices int := 0; v_native int := 0;
begin
  select * into v_target from profiles where id = p_profile_id;
  if not found then raise exception 'staff member not found' using errcode='22023'; end if;

  select * into g from assert_can_manage(v_target.role);

  if v_target.course_id <> g.course_id then
    raise exception 'that person is not at your club' using errcode = '42501';
  end if;
  if p_profile_id = g.actor_id and not p_active then
    raise exception 'you cannot deactivate yourself' using errcode = '42501';
  end if;

  update profiles set active = p_active, on_duty = case when p_active then on_duty else false end
   where id = p_profile_id;

  if not p_active then
    -- End the session rather than waiting for the token to expire. Guarded
    -- because these tables belong to GoTrue, not to this schema: a Postgres
    -- without it should lose the revocation, not the deactivation.
    if to_regclass('auth.sessions') is not null then
      with gone as (delete from auth.sessions where user_id = p_profile_id returning 1)
      select count(*) into v_sessions from gone;
    end if;
    if to_regclass('auth.refresh_tokens') is not null then
      delete from auth.refresh_tokens where user_id::uuid = p_profile_id;
    end if;

    -- And stop the phone buzzing — the browser's subscription and the native
    -- app's token alike. resolve_recipients already skips inactive people, so
    -- this is belt and braces; but a device left registered to a departed
    -- employee is a thing nobody would think to look for.
    with dropped as (delete from push_subscriptions where profile_id = p_profile_id returning 1)
    select count(*) into v_devices from dropped;
    with dropped as (delete from device_tokens where profile_id = p_profile_id returning 1)
    select count(*) into v_native from dropped;
  end if;

  perform log_admin_event(g.course_id, g.actor_id,
    (case when p_active then 'staff_activated' else 'staff_deactivated' end)::admin_event_type,
    p_profile_id,
    jsonb_build_object('full_name', v_target.full_name,
                       'sessions_ended', v_sessions,
                       'devices_removed', v_devices + v_native));
end;
$$;

-- Restated after the create-or-replace: a replaced function must not drift back
-- to EXECUTE for PUBLIC.
revoke all on function set_staff_active(uuid, boolean) from public, anon;
grant execute on function set_staff_active(uuid, boolean) to authenticated;
