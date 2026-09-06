-- An invitation is for somebody you are allowed to manage, and the database
-- says who that is.
--
-- The hole, verified in PGlite rather than reasoned about: create_staff_invite
-- took an email and called assert_can_manage(null). Null means "no target role
-- to check", so the only question asked was "are you a manager or owner". A
-- manager could therefore mint an invitation for the OWNER's address — or for
-- any address at all. redeemInvite() in app/actions/staff.ts then spends that
-- token, calls auth.admin.generateLink({type:'recovery', email}) for whatever
-- email the row holds, and hands the caller the hashed token. So a manager who
-- typed the owner's email into the sign-in-link button got an owner session,
-- and "only an owner can manage owners" — enforced faithfully by every other
-- function in 20260905120000_staff_admin.sql — meant nothing. The moment a
-- second club exists the same path signs in as any user at any club, because
-- the email was never checked against the caller's course_id either.
--
-- The rule: an invitation resolves to a person at the caller's club first —
-- an active profile, or an unclaimed pending_profiles row — and the guard is
-- then asked about THAT person's role, exactly as set_staff_role and
-- set_staff_active already do. An address that matches nobody at the club is
-- refused with the same message whether it belongs to another club or to
-- nobody, so the function cannot be used to probe which emails exist.
--
-- invite_staff gets the complementary check: it cannot create a pending row
-- for an address that already has an active account here. Without it a manager
-- could invite the owner's email as 'staff', producing an unclaimed pending row
-- whose role passes assert_can_manage, and then mint a link for it.
create or replace function create_staff_invite(p_email text)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare g record; v_token text; v_email text := lower(btrim(p_email)); v_role staff_role;
begin
  select * into g from assert_can_manage(null);

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'that is not an email address' using errcode = '22023';
  end if;

  -- Who is this for? Only somebody at the caller's club counts: an active
  -- account first, else an invitation they have not yet claimed.
  select p.role into v_role
    from profiles p
   where p.course_id = g.course_id and p.active and lower(p.email) = v_email
   limit 1;

  if v_role is null then
    select pp.role into v_role
      from pending_profiles pp
     where pp.course_id = g.course_id and pp.claimed_at is null and lower(pp.email) = v_email
     limit 1;
  end if;

  -- One message for "another club" and "nobody": the error must not reveal
  -- which addresses exist anywhere in the system.
  if v_role is null then
    raise exception 'that person is not at your club' using errcode = '22023';
  end if;

  -- The same guard the other staff functions use, now asked about the person
  -- the link would sign in. A manager is refused for an owner here.
  perform assert_can_manage(v_role);

  update staff_invites set used_at = now()
   where lower(email) = v_email and course_id = g.course_id and used_at is null;

  insert into staff_invites (course_id, email, created_by)
  values (g.course_id, v_email, g.actor_id)
  returning token into v_token;

  return v_token;
end;
$$;

revoke all on function create_staff_invite(text) from public, anon, authenticated;
grant execute on function create_staff_invite(text) to authenticated;

create or replace function invite_staff(
  p_email text, p_full_name text, p_role staff_role,
  p_department_ids uuid[] default '{}', p_phone text default null
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare g record; v_id uuid; v_email text := lower(btrim(p_email));
begin
  select * into g from assert_can_manage(p_role);

  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'a valid email is required' using errcode = '22023';
  end if;

  -- Somebody with a live account is not invited again. Allowing it would create
  -- an unclaimed pending row carrying whatever role the caller chose, and the
  -- invitation path above would then trust that role instead of the real one.
  if exists (
    select 1 from profiles p
     where p.course_id = g.course_id and p.active and lower(p.email) = v_email
  ) then
    raise exception 'that person already has an account' using errcode = '22023';
  end if;

  insert into pending_profiles (course_id, email, full_name, phone, role, department_ids)
  values (g.course_id, v_email, btrim(p_full_name), p_phone, p_role, p_department_ids)
  on conflict (course_id, email) do update
    set full_name = excluded.full_name, role = excluded.role,
        phone = excluded.phone, department_ids = excluded.department_ids,
        claimed_at = null
  returning id into v_id;

  perform log_admin_event(g.course_id, g.actor_id, 'staff_invited', v_id,
    jsonb_build_object('email', v_email, 'role', p_role));
  return v_id;
end;
$$;

-- Restated after the create-or-replace: a replaced function must not drift back
-- to the default of EXECUTE for PUBLIC, which is how this surface leaked before.
revoke all on function invite_staff(text,text,staff_role,uuid[],text) from public, anon, authenticated;
grant execute on function invite_staff(text,text,staff_role,uuid[],text) to authenticated;
