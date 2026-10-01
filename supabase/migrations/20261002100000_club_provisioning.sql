-- A club that works the day it is created.
--
-- create_club built a course, seven departments, ten routing rules and an
-- owner invite, and no locations at all. No locations means no placard can be
-- minted, which means no member can report anything: the owner signed in to a
-- shell that looked complete and could not receive a single report. Found by
-- reading the function against what a first customer would actually do.
--
--   create_club()         gains a course template. Holes in play order plus
--                         the facilities every club has, and a placard for
--                         each, because a location without a code is still
--                         not reachable by a member.
--   mint_placard_batch()  mints the missing ones in a single call, so an
--                         owner prints one sheet instead of clicking through
--                         two dozen locations.
--
-- Deliberately NOT done here: mint_placard_batch does not regenerate existing
-- codes by default. Regenerating retires every active placard at once, which
-- kills every physical sign on the course. That is a real action a club may
-- want after replacing its signage, so it stays available behind an explicit
-- argument, and it is audited per location exactly as mint_placard is.

-- ---------------------------------------------------------- the template

-- Shared by create_club and by any later "add the back nine" work, so the
-- naming and ordering of a standard course exists once.
create or replace function install_course_template(
  p_course uuid, p_holes int default 18
) returns int
language plpgsql volatile security definer set search_path = public as $$
declare v_made int := 0;
begin
  if p_holes is null or p_holes not between 0 and 72 then
    raise exception 'a course has between 0 and 72 holes' using errcode = '22023';
  end if;

  -- Holes first, numbered and ordered the way a person walks them. sort_order
  -- matches the hole number so the placard sheet and the filing picker agree
  -- without either of them re-sorting.
  insert into locations (course_id, kind, hole_number, name, sort_order)
  select p_course, 'hole', n, 'Hole ' || n, n
    from generate_series(1, p_holes) as n
   where not exists (
     select 1 from locations l where l.course_id = p_course and l.hole_number = n
   );
  get diagnostics v_made = row_count;

  -- The places that are not holes. Ordered after every possible hole so they
  -- always sit below, whatever the hole count.
  insert into locations (course_id, kind, hole_number, name, sort_order)
  select p_course, t.kind::location_kind, null, t.name, t.ord
    from (values
      ('clubhouse'::text,     'Clubhouse',          100),
      ('practice',            'Practice Range',     101),
      ('practice',            'Putting Green',      102),
      ('cart_barn',           'Cart Barn',          103),
      ('halfway_house',       'Halfway House',      104),
      ('restroom',            'Restroom — Front 9', 105),
      ('restroom',            'Restroom — Back 9',  106)
    ) as t(kind, name, ord)
   where not exists (
     select 1 from locations l where l.course_id = p_course and l.name = t.name
   );

  -- A location nobody can scan is not reachable, so every active location
  -- that has no live code gets one. Token takes the table default.
  insert into qr_codes (course_id, location_id)
  select p_course, l.id
    from locations l
   where l.course_id = p_course and l.active
     and not exists (
       select 1 from qr_codes q where q.location_id = l.id and q.active
     );

  return (select count(*)::int from locations where course_id = p_course);
end;
$$;
revoke all on function install_course_template(uuid, int) from public, anon, authenticated;
grant execute on function install_course_template(uuid, int) to service_role;

-- ------------------------------------------------------------ create_club

drop function if exists create_club(text, text, text, text, text);

create or replace function create_club(
  p_slug text, p_name text, p_timezone text, p_owner_email text, p_owner_name text,
  p_holes int default 18
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_slug   text := btrim(coalesce(p_slug, ''));
  v_name   text := btrim(coalesce(p_name, ''));
  v_email  text := lower(btrim(coalesce(p_owner_email, '')));
  v_owner  text := btrim(coalesce(p_owner_name, ''));
  v_course uuid;
  v_depts  uuid[];
  v_places int;
begin
  if v_slug !~ '^[a-z0-9-]{3,40}$' then
    raise exception 'the slug must be 3 to 40 lowercase letters, digits or hyphens' using errcode = '22023';
  end if;
  if exists (select 1 from courses where slug = v_slug) then
    raise exception 'that club already exists' using errcode = '23505';
  end if;
  if length(v_name) not between 2 and 80 then
    raise exception 'the club name must be between 2 and 80 characters' using errcode = '22023';
  end if;
  if p_timezone is null
     or not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'unknown timezone' using errcode = '22023';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'the owner needs an email address' using errcode = '22023';
  end if;
  if length(v_owner) not between 2 and 80 then
    raise exception 'the owner''s name must be between 2 and 80 characters' using errcode = '22023';
  end if;

  insert into courses (slug, name, timezone, settings)
  values (v_slug, v_name, p_timezone, '{}'::jsonb)
  returning id into v_course;

  -- docs/taxonomy.md, Departments table, in the order it lists them.
  insert into departments (course_id, key, name, sort_order) values
    (v_course, 'maintenance',  'Course Maintenance', 1),
    (v_course, 'cart_fleet',   'Cart Fleet',         2),
    (v_course, 'pro_shop',     'Pro Shop',           3),
    (v_course, 'pace_of_play', 'Player Assistance',  4),
    (v_course, 'f_and_b',      'Food & Beverage',    5),
    (v_course, 'caddie',       'Caddie & Valet',     6),
    (v_course, 'management',   'Management',         7);

  -- docs/taxonomy.md, Categories table: category, department key, ack,
  -- resolve, and whether a member number is needed to resolve. The member_no
  -- column arrived in 20260906180000; rebuilding this function from the
  -- 170000 body silently dropped it, and test:club-create caught it.
  insert into routing_rules (course_id, category, department_id, ack_sla_minutes, resolve_sla_minutes, requires_member_no)
  select v_course, t.category, d.id, t.ack, t.resolve, t.member_no
    from (values
      ('pace_of_play',        'pace_of_play', 10, 30,  false),
      ('course_maintenance',  'maintenance',  15, 240, false),
      ('cart_issue',          'cart_fleet',   10, 45,  false),
      ('pro_shop',            'pro_shop',     15, 60,  false),
      ('f_and_b',             'f_and_b',      10, 30,  true),
      ('restroom_facilities', 'maintenance',  20, 120, false),
      ('practice_facility',   'pro_shop',     30, 240, false),
      ('safety',              'management',    5, 30,  false),
      ('caddie_valet',        'caddie',       10, 30,  false),
      ('needs_review',        'management',   15, 120, false)
    ) as t(category, dept_key, ack, resolve, member_no)
    join departments d on d.course_id = v_course and d.key = t.dept_key;

  -- Holes, facilities and a placard for each. Without this the club cannot
  -- take a single report, which is the bug this migration exists to fix.
  v_places := install_course_template(v_course, coalesce(p_holes, 18));

  select array_agg(id order by sort_order) into v_depts from departments where course_id = v_course;
  insert into pending_profiles (course_id, email, full_name, role, department_ids)
  values (v_course, v_email, v_owner, 'owner', v_depts);

  perform log_admin_event(v_course, null, 'settings_changed', v_course,
    jsonb_build_object('event', 'club_created', 'slug', v_slug, 'owner_email', v_email,
                       'locations', v_places, 'holes', coalesce(p_holes, 18)));

  return v_course;
end;
$$;
revoke all on function create_club(text,text,text,text,text,int) from public, anon, authenticated;
grant execute on function create_club(text,text,text,text,text,int) to service_role;

-- ------------------------------------------------------- minting in bulk

create or replace function mint_placard_batch(p_regenerate boolean default false)
returns table (location_id uuid, name text, token text)
language plpgsql volatile security definer set search_path = public as $$
declare g record; v_loc record; v_token text; v_old text[];
begin
  select * into g from assert_can_manage(null);

  -- Every reference below is qualified or aliased. The three OUT parameters
  -- are named location_id, name and token, which are also column names on
  -- qr_codes and locations; a bare `returning token` is ambiguous between the
  -- two and Postgres refuses it. test:club-create caught that.
  for v_loc in
    select l.id as loc_id, l.name as loc_name
      from locations l
     where l.course_id = g.course_id and l.active
       and (p_regenerate or not exists (
         select 1 from qr_codes q where q.location_id = l.id and q.active
       ))
     order by l.hole_number nulls last, l.sort_order, l.name
  loop
    with retired as (
      update qr_codes q set active = false
       where q.location_id = v_loc.loc_id and q.active
      returning q.token as tok
    )
    select coalesce(array_agg(left(r.tok, 6)), '{}') into v_old from retired r;

    insert into qr_codes (course_id, location_id)
    values (g.course_id, v_loc.loc_id)
    returning qr_codes.token into v_token;

    -- Audited per location, the same event mint_placard writes, so a batch
    -- and a single mint are indistinguishable in the record.
    perform log_admin_event(g.course_id, g.actor_id, 'placard_regenerated', v_loc.loc_id,
      jsonb_build_object('name', v_loc.loc_name, 'retired_prefixes', to_jsonb(v_old),
                         'new_prefix', left(v_token, 6), 'batch', true));

    location_id := v_loc.loc_id; name := v_loc.loc_name; token := v_token;
    return next;
  end loop;
end;
$$;
revoke all on function mint_placard_batch(boolean) from public, anon;
grant execute on function mint_placard_batch(boolean) to authenticated;

-- ------------------------------------------------- is this club ready yet

-- What a new club still has to do, answered from live data rather than from
-- a flag somebody ticks. A checklist that tracks its own state can be marked
-- complete while the club is still unreachable; this one cannot lie, and it
-- disappears by the work actually being done.
--
-- A database function, not a TypeScript query, because lib/queue reads every
-- row twice — once for the offline harness and once for Supabase — and that
-- duplication is already on the debt register. One implementation, two
-- callers, the pattern the rest of the app follows.
--
-- Printing is deliberately not a checkbox here. qr_codes.printed_at exists
-- and nothing sets it, so the box could never tick; the screen links to the
-- print sheet instead of pretending to track it.
create or replace function club_readiness()
returns table (
  has_team         boolean,
  can_be_alerted   boolean,
  has_sign_address boolean,
  staff_count      int,
  reachable_count  int,
  location_count   int
)
language sql stable security definer set search_path = public as $$
  with me as (select auth_course_id() as course_id),
  staff as (
    select p.id,
           exists (select 1 from push_subscriptions s where s.profile_id = p.id)
        or exists (select 1 from device_tokens d where d.profile_id = p.id) as reachable
      from profiles p, me
     where p.course_id = me.course_id and p.active and p.account_kind = 'individual'
  )
  select
    (select count(*) from staff) > 1,
    (select count(*) from staff where reachable) > 0,
    coalesce(nullif(btrim((select c.settings ->> 'public_url' from courses c, me where c.id = me.course_id)), ''), '') <> '',
    (select count(*)::int from staff),
    (select count(*)::int from staff where reachable),
    (select count(*)::int from locations l, me where l.course_id = me.course_id and l.active)
  from me;
$$;
revoke all on function club_readiness() from public, anon;
grant execute on function club_readiness() to authenticated;

