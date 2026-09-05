-- Account management: who may change what about whom.
--
-- The hole this closes was found by trying it: a line staff member, signed in
-- with nothing but the publishable key, could send one PostgREST update and
-- become an owner.
--
--   update profiles set role = 'owner' where id = <self>   ->  ALLOWED
--
-- Every guard downstream was correct. assert_can_manage checks your role
-- before letting you touch anyone else; assert_actor checks it before letting
-- you act on a report. None of them anticipated that you could set your own.
--
-- The cause is that RLS grants access to ROWS, not columns. The self_update
-- policy exists for a good reason — a person must be able to go on duty from
-- their own phone — but "you may update your own row" is the only thing a
-- policy can say, and that row contains `role`, `active` and `course_id`.
--
-- Postgres has the right primitive, and it is not a policy: column-level
-- grants. This is deliberately not solved with a set_my_profile() RPC. An RPC
-- guards one path; a grant guards every path, including the raw PostgREST call
-- used to find this. The same lesson the anon lockdown taught — grants and RLS
-- are two independent lines of defence and both must hold.

-- Table-level UPDATE also carried DELETE, INSERT and TRUNCATE, which RLS was
-- quietly refusing on every path. Nothing needs them.
revoke all on profiles from authenticated;

grant select on profiles to authenticated;

-- Exactly the columns a person may change about themselves. Anything absent —
-- role, active, course_id, account_kind, on_duty_since, created_at, id — is a
-- decision the club makes about them, and goes through a function that checks
-- who is asking and writes an audit row.
grant update (full_name, phone, preferred_language, on_duty)
  on profiles to authenticated;

-- The row filter still applies on top: these columns, on your own row only.
-- Both halves are load-bearing. Without the policy you could edit a colleague's
-- name; without the grant you could edit your own role.

/**
 * Go on or off duty.
 *
 * The column grant above is what makes this safe, but a function is still the
 * better front door: it stamps on_duty_since, which the grant deliberately does
 * not expose — a person setting their own "since" is how duty-time reporting
 * becomes fiction.
 */
create or replace function set_my_duty(p_on_duty boolean)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  update profiles
     set on_duty = p_on_duty,
         on_duty_since = case when p_on_duty then now() else null end
   where id = v_uid and active;

  if not found then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return p_on_duty;
end;
$$;

revoke all on function set_my_duty(boolean) from public, anon;
grant execute on function set_my_duty(boolean) to authenticated;

/**
 * Offboarding that actually ends access.
 *
 * Deactivating flipped a flag. Every guard reads that flag, so the person could
 * do nothing — but their session stayed valid for up to an hour, during which
 * they could still READ the club's reports, and their phone kept its push
 * subscription. "Deactivation works; nothing records it" was the note in
 * CLAUDE.md; the recording was added later, and this is the other half.
 *
 * Deleting the session rows is what Supabase itself does on sign-out. Done here
 * rather than in the app so it cannot be skipped by a different caller, and so
 * it commits in the same transaction as the deactivation — a revoked session
 * with the flag left set, or the reverse, is worse than either.
 */
create or replace function set_staff_active(p_profile_id uuid, p_active boolean)
returns void language plpgsql volatile security definer set search_path = public as $$
declare g record; v_target profiles%rowtype; v_sessions int := 0; v_devices int := 0;
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

    -- And stop the phone buzzing. resolve_recipients already skips inactive
    -- people, so this is belt and braces — but a device left registered to a
    -- departed employee is a thing nobody would think to look for.
    with dropped as (delete from push_subscriptions where profile_id = p_profile_id returning 1)
    select count(*) into v_devices from dropped;
  end if;

  perform log_admin_event(g.course_id, g.actor_id,
    (case when p_active then 'staff_activated' else 'staff_deactivated' end)::admin_event_type,
    p_profile_id,
    jsonb_build_object('full_name', v_target.full_name,
                       'sessions_ended', v_sessions,
                       'devices_removed', v_devices));
end;
$$;

revoke all on function set_staff_active(uuid, boolean) from public, anon;
grant execute on function set_staff_active(uuid, boolean) to authenticated;

/**
 * Joining the club is a staff change too.
 *
 * Every other mutation on the roster writes an admin_events row. Claiming an
 * invitation — the moment a person actually becomes staff and can see the
 * club's reports — wrote nothing, so the audit trail began after the only event
 * that granted access. The actor is the person themselves, which is the honest
 * record: a manager invited, but this is the person accepting.
 *
 * The email is taken from auth.users rather than the invitation, so
 * profiles.email is what they actually sign in with and cannot drift from it.
 */
create or replace function claim_profile()
returns table (claimed boolean, course_slug text, full_name text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text;
  v_pending pending_profiles%rowtype;
  v_slug    text;
  v_name    text;
begin
  if v_uid is null then
    return query select false, null::text, null::text;
    return;
  end if;

  select p.full_name, c.slug into v_name, v_slug
    from profiles p join courses c on c.id = p.course_id
   where p.id = v_uid;
  if found then
    return query select true, v_slug, v_name;
    return;
  end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null then
    return query select false, null::text, null::text;
    return;
  end if;

  select * into v_pending
    from pending_profiles
   where lower(email) = lower(v_email) and claimed_at is null;

  if not found then
    return query select false, null::text, null::text;
    return;
  end if;

  insert into profiles (id, course_id, full_name, email, phone, role, on_duty)
  values (v_uid, v_pending.course_id, v_pending.full_name, v_email,
          v_pending.phone, v_pending.role, true)
  on conflict (id) do nothing;

  insert into staff_departments (profile_id, department_id)
  select v_uid, unnest(v_pending.department_ids)
  on conflict do nothing;

  update pending_profiles set claimed_at = now() where id = v_pending.id;

  perform log_admin_event(v_pending.course_id, v_uid, 'staff_invited',
    v_uid, jsonb_build_object('event', 'claimed',
                              'full_name', v_pending.full_name,
                              'role', v_pending.role));

  select slug into v_slug from courses where id = v_pending.course_id;
  return query select true, v_slug, v_pending.full_name;
end;
$$;

revoke all on function claim_profile() from public, anon;
grant execute on function claim_profile() to authenticated;
