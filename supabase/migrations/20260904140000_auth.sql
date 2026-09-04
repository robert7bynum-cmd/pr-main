-- Linking a Supabase auth user to a staff profile.
--
-- Staff never sign themselves up: an admin creates a pending_profiles row for
-- their email, and the first time that person completes a magic-link sign-in
-- this claims it. Until claimed, an authenticated user has no profile, so
-- auth_course_id() returns null and RLS shows them nothing — a stranger who
-- signs in with an unknown email sees an empty app rather than a club's data.

create or replace function claim_profile()
returns table (claimed boolean, course_slug text, full_name text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text;
  v_pending pending_profiles%rowtype;
  v_slug    text;
begin
  if v_uid is null then
    return query select false, null::text, null::text;
    return;
  end if;

  -- Already linked: nothing to do.
  select p.full_name, c.slug into v_pending.full_name, v_slug
    from profiles p join courses c on c.id = p.course_id
   where p.id = v_uid;
  if found then
    return query select true, v_slug, v_pending.full_name;
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
    -- No invitation for this address. Deliberately not an error the caller can
    -- probe: they simply have no profile and therefore see nothing.
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

  select slug into v_slug from courses where id = v_pending.course_id;
  return query select true, v_slug, v_pending.full_name;
end;
$$;

grant execute on function claim_profile() to authenticated;

-- Who am I, for the staff app header and for attributing actions.
create or replace function me()
returns table (
  profile_id uuid, full_name text, role staff_role,
  course_id uuid, course_name text, on_duty boolean
)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.role, p.course_id, c.name, p.on_duty
    from profiles p join courses c on c.id = p.course_id
   where p.id = auth.uid() and p.active
$$;

grant execute on function me() to authenticated;
