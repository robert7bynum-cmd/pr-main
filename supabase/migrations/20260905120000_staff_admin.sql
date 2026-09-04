-- Staff management.
--
-- Every mutation is a SECURITY DEFINER function rather than a table write, so
-- the privilege rules live in one place and cannot be bypassed by a different
-- client. Three rules, each guarding a specific attack:
--
--   1. You cannot change your own role. Self-escalation is the obvious move.
--   2. Only an owner creates or modifies owners. A manager cannot mint a peer
--      above themselves.
--   3. Everything is scoped to the actor's own club, checked inside the
--      function — not left to the caller to get right.

-- Shared guard. Raises rather than returning false: a caller that ignores a
-- boolean is a privilege bug waiting to happen.
create or replace function assert_can_manage(p_target_role staff_role default null)
returns table (actor_id uuid, course_id uuid, actor_role staff_role)
language plpgsql stable security definer set search_path = public as $$
declare v_actor uuid := auth.uid(); v_role staff_role; v_course uuid;
begin
  select p.role, p.course_id into v_role, v_course
    from profiles p where p.id = v_actor and p.active;

  if v_role is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_role not in ('manager', 'owner') then
    raise exception 'you do not manage staff at this club' using errcode = '42501';
  end if;
  -- Only an owner may create or alter another owner.
  if p_target_role = 'owner' and v_role <> 'owner' then
    raise exception 'only an owner can manage owners' using errcode = '42501';
  end if;

  return query select v_actor, v_course, v_role;
end;
$$;

-- Invite a staff member. Creates the pending profile their first sign-in
-- claims; the auth account itself is created by the app, which holds the
-- service key.
create or replace function invite_staff(
  p_email text, p_full_name text, p_role staff_role,
  p_department_ids uuid[] default '{}', p_phone text default null
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare g record; v_id uuid;
begin
  select * into g from assert_can_manage(p_role);

  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'a valid email is required' using errcode = '22023';
  end if;

  insert into pending_profiles (course_id, email, full_name, phone, role, department_ids)
  values (g.course_id, lower(btrim(p_email)), btrim(p_full_name), p_phone, p_role, p_department_ids)
  on conflict (course_id, email) do update
    set full_name = excluded.full_name, role = excluded.role,
        phone = excluded.phone, department_ids = excluded.department_ids,
        claimed_at = null
  returning id into v_id;

  perform log_admin_event(g.course_id, g.actor_id, 'staff_invited', v_id,
    jsonb_build_object('email', lower(btrim(p_email)), 'role', p_role));
  return v_id;
end;
$$;

create or replace function set_staff_active(p_profile_id uuid, p_active boolean)
returns void language plpgsql volatile security definer set search_path = public as $$
declare g record; v_target profiles%rowtype;
begin
  select * into v_target from profiles where id = p_profile_id;
  if not found then raise exception 'staff member not found' using errcode='22023'; end if;

  select * into g from assert_can_manage(v_target.role);

  -- Cross-club protection lives here, not in the caller.
  if v_target.course_id <> g.course_id then
    raise exception 'that person is not at your club' using errcode = '42501';
  end if;
  -- Deactivating yourself locks you out of your own club.
  if p_profile_id = g.actor_id and not p_active then
    raise exception 'you cannot deactivate yourself' using errcode = '42501';
  end if;

  update profiles set active = p_active, on_duty = case when p_active then on_duty else false end
   where id = p_profile_id;

  perform log_admin_event(g.course_id, g.actor_id,
    (case when p_active then 'staff_activated' else 'staff_deactivated' end)::admin_event_type,
    p_profile_id, jsonb_build_object('name', v_target.full_name));
end;
$$;

create or replace function set_staff_role(p_profile_id uuid, p_role staff_role)
returns void language plpgsql volatile security definer set search_path = public as $$
declare g record; v_target profiles%rowtype;
begin
  select * into v_target from profiles where id = p_profile_id;
  if not found then raise exception 'staff member not found' using errcode='22023'; end if;

  -- Checked against both the current and the new role: a manager must not be
  -- able to demote an owner either.
  select * into g from assert_can_manage(greatest(v_target.role, p_role));

  if v_target.course_id <> g.course_id then
    raise exception 'that person is not at your club' using errcode = '42501';
  end if;
  -- The self-escalation guard.
  if p_profile_id = g.actor_id then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;

  update profiles set role = p_role where id = p_profile_id;

  perform log_admin_event(g.course_id, g.actor_id, 'staff_role_changed', p_profile_id,
    jsonb_build_object('from', v_target.role, 'to', p_role, 'name', v_target.full_name));
end;
$$;

create or replace function set_staff_departments(p_profile_id uuid, p_department_ids uuid[])
returns void language plpgsql volatile security definer set search_path = public as $$
declare g record; v_target profiles%rowtype;
begin
  select * into v_target from profiles where id = p_profile_id;
  if not found then raise exception 'staff member not found' using errcode='22023'; end if;

  select * into g from assert_can_manage(v_target.role);
  if v_target.course_id <> g.course_id then
    raise exception 'that person is not at your club' using errcode = '42501';
  end if;

  -- Departments must belong to the same club; otherwise a crafted id could
  -- attach someone to another club's team.
  if exists (
    select 1 from unnest(p_department_ids) d(id)
     where not exists (select 1 from departments
                        where departments.id = d.id and departments.course_id = g.course_id)
  ) then
    raise exception 'unknown department for this club' using errcode = '22023';
  end if;

  delete from staff_departments where profile_id = p_profile_id;
  insert into staff_departments (profile_id, department_id)
  select p_profile_id, unnest(p_department_ids);

  perform log_admin_event(g.course_id, g.actor_id, 'staff_departments_changed', p_profile_id,
    jsonb_build_object('count', coalesce(array_length(p_department_ids,1),0),
                       'name', v_target.full_name));
end;
$$;

-- The roster an admin screen renders.
create or replace function staff_roster()
returns table (
  profile_id uuid, full_name text, email text, role staff_role,
  active boolean, on_duty boolean, account_kind account_kind,
  departments text[], resolved_30d int
)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.email, p.role, p.active, p.on_duty, p.account_kind,
         coalesce(array_agg(d.name order by d.name) filter (where d.name is not null), '{}'),
         (select count(*)::int from reports r
           where r.resolved_by = p.id and r.resolved_at > now() - interval '30 days')
    from profiles p
    left join staff_departments sd on sd.profile_id = p.id
    left join departments d on d.id = sd.department_id
   where p.course_id = auth_course_id() and auth_is_management()
   group by p.id
   order by p.active desc, p.full_name;
$$;

revoke all on function assert_can_manage(staff_role)          from public, anon;
revoke all on function invite_staff(text,text,staff_role,uuid[],text) from public, anon;
revoke all on function set_staff_active(uuid,boolean)         from public, anon;
revoke all on function set_staff_role(uuid,staff_role)        from public, anon;
revoke all on function set_staff_departments(uuid,uuid[])     from public, anon;
revoke all on function staff_roster()                         from public, anon;

grant execute on function invite_staff(text,text,staff_role,uuid[],text) to authenticated;
grant execute on function set_staff_active(uuid,boolean)      to authenticated;
grant execute on function set_staff_role(uuid,staff_role)     to authenticated;
grant execute on function set_staff_departments(uuid,uuid[])  to authenticated;
grant execute on function staff_roster()                      to authenticated;
