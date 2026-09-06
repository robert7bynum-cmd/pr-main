-- The write path 20260906100000 took away, given back as functions.
--
-- That migration made locations, departments, qr_codes, venues and
-- pending_profiles read-only for every signed-in user, correctly: nothing in
-- the app wrote them, and a manager holding a session could re-point a placard
-- by hand with no audit row. But nothing replaced the write path. Since then a
-- club could not rename a hole, add the halfway house, set quiet hours, set the
-- address its placards encode, or replace a defaced sign without a developer
-- running SQL against production. The settings screen and the locations screen
-- both read this migration; the rule is the same one staff management follows:
-- every mutation is a SECURITY DEFINER function, the guards live inside it,
-- and every change is an admin_events row.
--
-- Six functions:
--
--   update_course_settings  name, timezone, placard address, quiet hours
--   upsert_location         add a location or rename one
--   set_location_active     retire a location, or bring it back
--   upsert_department       add a department or rename one (never delete)
--   mint_placard            retire a location's current code and issue a new one
--   get_scan_context        re-created: a retired location's code stops resolving
--
-- Two rules deserve a sentence each.
--
-- The placard address is refused, not warned about, when it is one that cannot
-- survive printing: localhost and its aliases, or a Vercel branch preview.
-- app/app/placards/page.tsx already refuses to render the sheet for such an
-- address; this stops the address being stored in the first place, so the
-- refusal on the placard page is a backstop rather than the only control. The
-- two patterns are the ones lib/placards/origin.ts exports, byte for byte, and
-- scripts/test-placard-origin.mts reads this file and checks that they still
-- are. The one enum this needs, admin_event_type, already carries
-- 'location_changed', 'placard_regenerated' and 'settings_changed' from
-- 20260905110000, so no value is added here — an added enum value cannot be
-- used inside the transaction that adds it, and db:apply wraps each migration
-- in one.
--
-- A location is retired, never deleted. Reports reference it, and a report
-- whose location is gone is a report nobody can find on the course. Retiring
-- one with open reports is refused outright: the person fixing the problem
-- needs the name on their screen to still mean something.
--
-- Re-runnable: add column if not exists, create or replace, and grants restated
-- after every function so a replaced body cannot drift back to EXECUTE for
-- PUBLIC.

-- ------------------------------------------------------------ locations.active
alter table locations add column if not exists active boolean not null default true;

-- ---------------------------------------------------- update_course_settings
-- Returns the number of settings that actually changed, for the same reason
-- update_routing_rules does: a save that changed nothing is reported as
-- nothing, not as success.
create or replace function update_course_settings(
  p_name text, p_timezone text, p_public_url text, p_quiet_start text, p_quiet_end text
) returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  g          record;
  v_course   courses%rowtype;
  v_name     text := btrim(coalesce(p_name, ''));
  v_url      text;
  v_settings jsonb;
  v_before   jsonb;
  v_after    jsonb;
  v_from     jsonb := '{}'::jsonb;
  v_to       jsonb := '{}'::jsonb;
  v_key      text;
  v_changed  int := 0;
  -- SHARED WITH lib/placards/origin.ts — UNPRINTABLE_HOST_PATTERN and
  -- UNPRINTABLE_PREVIEW_PATTERN, verbatim. scripts/test-placard-origin.mts
  -- asserts that this file contains both strings exactly as that module
  -- exports them, so neither side can be edited alone.
  v_host_pattern    text := '^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$|/)';
  v_preview_pattern text := '-git-[^.]+\.vercel\.app';
begin
  select * into g from assert_can_manage(null);
  select * into v_course from courses where id = g.course_id;

  if length(v_name) not between 2 and 80 then
    raise exception 'the club name must be between 2 and 80 characters' using errcode = '22023';
  end if;

  if p_timezone is null
     or not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'unknown timezone' using errcode = '22023';
  end if;

  -- The placard address. Stored without a trailing slash so the code is
  -- origin + /r/<slug>/<token> and never origin//r. https only: a printed sign
  -- is not the place to find out the club's host redirects.
  v_url := nullif(regexp_replace(btrim(coalesce(p_public_url, '')), '/+$', ''), '');
  if v_url is not null then
    if v_url !~* '^https://[^/\s]+' then
      raise exception 'the address must start with https://' using errcode = '22023';
    end if;
    if regexp_replace(v_url, '^https?://', '', 'i') ~* v_host_pattern
       or v_url ~* v_preview_pattern then
      raise exception 'that address cannot go on a printed sign' using errcode = '22023';
    end if;
  end if;

  -- Quiet hours: both or neither, HH:MM each. within_quiet_hours casts these
  -- straight to time, so a malformed value there would stop the escalation
  -- sweep for the whole club.
  if (p_quiet_start is null) <> (p_quiet_end is null) then
    raise exception 'quiet hours need both a start and an end' using errcode = '22023';
  end if;
  if p_quiet_start is not null
     and (p_quiet_start !~ '^([01]\d|2[0-3]):[0-5]\d$' or p_quiet_end !~ '^([01]\d|2[0-3]):[0-5]\d$') then
    raise exception 'quiet hours must be HH:MM' using errcode = '22023';
  end if;

  v_settings := v_course.settings;
  v_settings := case when v_url is null then v_settings - 'public_url'
                     else jsonb_set(v_settings, '{public_url}', to_jsonb(v_url)) end;
  v_settings := case when p_quiet_start is null then v_settings - 'quiet_hours'
                     else jsonb_set(v_settings, '{quiet_hours}',
                            jsonb_build_object('start', p_quiet_start, 'end', p_quiet_end)) end;

  v_before := jsonb_build_object('name', v_course.name, 'timezone', v_course.timezone,
                                 'public_url', v_course.settings -> 'public_url',
                                 'quiet_hours', v_course.settings -> 'quiet_hours');
  v_after  := jsonb_build_object('name', v_name, 'timezone', p_timezone,
                                 'public_url', v_settings -> 'public_url',
                                 'quiet_hours', v_settings -> 'quiet_hours');

  -- Only the keys that changed go in the record, so the log stays readable.
  for v_key in select jsonb_object_keys(v_after) loop
    if v_before -> v_key is distinct from v_after -> v_key then
      v_from := v_from || jsonb_build_object(v_key, v_before -> v_key);
      v_to   := v_to   || jsonb_build_object(v_key, v_after -> v_key);
      v_changed := v_changed + 1;
    end if;
  end loop;

  if v_changed = 0 then
    return 0;
  end if;

  update courses set name = v_name, timezone = p_timezone, settings = v_settings
   where id = g.course_id;

  perform log_admin_event(g.course_id, g.actor_id, 'settings_changed', g.course_id,
    jsonb_build_object('kind', 'club', 'from', v_from, 'to', v_to));
  return v_changed;
end;
$$;

-- ------------------------------------------------------------ upsert_location
create or replace function upsert_location(
  p_id uuid, p_kind location_kind, p_hole_number int, p_name text, p_sort_order int
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  g        record;
  v_old    locations%rowtype;
  v_id     uuid;
  v_name   text := btrim(coalesce(p_name, ''));
  v_venue  uuid;
  v_sort   int;
begin
  select * into g from assert_can_manage(null);

  if length(v_name) not between 1 and 80 then
    raise exception 'the location needs a name of up to 80 characters' using errcode = '22023';
  end if;
  if p_kind = 'hole' and p_hole_number is null then
    raise exception 'a hole needs a hole number' using errcode = '22023';
  end if;
  if p_hole_number is not null and p_hole_number not between 1 and 99 then
    raise exception 'hole number must be between 1 and 99' using errcode = '22023';
  end if;

  if p_id is null then
    -- The club's first venue, the way the seed does it: a second venue is a
    -- property with two courses, which nothing here manages yet.
    select id into v_venue from venues where course_id = g.course_id
     order by sort_order, name limit 1;
    -- Holes sort by number; anything else goes after what is already there.
    select coalesce(p_sort_order, p_hole_number, max(sort_order) + 1, 1) into v_sort
      from locations where course_id = g.course_id;

    begin
      insert into locations (course_id, venue_id, kind, hole_number, name, sort_order)
      values (g.course_id, v_venue, p_kind, p_hole_number, v_name, v_sort)
      returning id into v_id;
    exception when unique_violation then
      raise exception 'that hole number is already used' using errcode = '23505';
    end;

    perform log_admin_event(g.course_id, g.actor_id, 'location_changed', v_id,
      jsonb_build_object('action', 'added', 'name', v_name, 'kind', p_kind,
                         'hole_number', p_hole_number));
    return v_id;
  end if;

  select * into v_old from locations where id = p_id;
  if not found or v_old.course_id <> g.course_id then
    raise exception 'that location is not at your club' using errcode = '42501';
  end if;

  begin
    update locations
       set kind = p_kind, hole_number = p_hole_number, name = v_name,
           sort_order = coalesce(p_sort_order, sort_order)
     where id = p_id;
  exception when unique_violation then
    raise exception 'that hole number is already used' using errcode = '23505';
  end;

  if v_old.name <> v_name or v_old.kind <> p_kind
     or v_old.hole_number is distinct from p_hole_number
     or (p_sort_order is not null and v_old.sort_order <> p_sort_order) then
    perform log_admin_event(g.course_id, g.actor_id, 'location_changed', p_id,
      jsonb_build_object('action', 'changed',
        'from', jsonb_build_object('name', v_old.name, 'kind', v_old.kind,
                                   'hole_number', v_old.hole_number, 'sort_order', v_old.sort_order),
        'to',   jsonb_build_object('name', v_name, 'kind', p_kind,
                                   'hole_number', p_hole_number,
                                   'sort_order', coalesce(p_sort_order, v_old.sort_order))));
  end if;
  return p_id;
end;
$$;

-- -------------------------------------------------------- set_location_active
create or replace function set_location_active(p_id uuid, p_active boolean)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare g record; v_old locations%rowtype; v_open int;
begin
  select * into g from assert_can_manage(null);

  select * into v_old from locations where id = p_id;
  if not found or v_old.course_id <> g.course_id then
    raise exception 'that location is not at your club' using errcode = '42501';
  end if;
  if v_old.active = p_active then
    raise exception 'that location is already %',
      case when p_active then 'active' else 'retired' end using errcode = '22023';
  end if;

  -- A retired location must not be one somebody is still working at.
  if not p_active then
    select count(*) into v_open from reports
     where location_id = p_id
       and status not in ('resolved', 'verified', 'closed_no_action');
    if v_open > 0 then
      raise exception 'close its open reports first' using errcode = '22023';
    end if;
  end if;

  update locations set active = p_active where id = p_id;

  perform log_admin_event(g.course_id, g.actor_id, 'location_changed', p_id,
    jsonb_build_object('action', case when p_active then 'restored' else 'retired' end,
                       'name', v_old.name));
end;
$$;

-- ---------------------------------------------------------- upsert_department
-- Rename or add. Never delete: routing_rules and staff_departments point at
-- these, and a department that disappears takes a club's routing with it.
create or replace function upsert_department(
  p_id uuid, p_key text, p_name text, p_sort_order int
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  g      record;
  v_old  departments%rowtype;
  v_id   uuid;
  v_key  text := lower(btrim(coalesce(p_key, '')));
  v_name text := btrim(coalesce(p_name, ''));
begin
  select * into g from assert_can_manage(null);

  if v_key !~ '^[a-z_]{2,32}$' then
    raise exception 'the key must be 2 to 32 lowercase letters or underscores' using errcode = '22023';
  end if;
  if length(v_name) not between 2 and 60 then
    raise exception 'the department name must be between 2 and 60 characters' using errcode = '22023';
  end if;

  if p_id is null then
    begin
      insert into departments (course_id, key, name, sort_order)
      select g.course_id, v_key, v_name, coalesce(p_sort_order, max(sort_order) + 1, 1)
        from departments where course_id = g.course_id
      returning id into v_id;
    exception when unique_violation then
      raise exception 'that department key is already used' using errcode = '23505';
    end;

    perform log_admin_event(g.course_id, g.actor_id, 'settings_changed', v_id,
      jsonb_build_object('kind', 'department', 'action', 'added', 'key', v_key, 'name', v_name));
    return v_id;
  end if;

  select * into v_old from departments where id = p_id;
  if not found or v_old.course_id <> g.course_id then
    raise exception 'that department is not at your club' using errcode = '42501';
  end if;

  begin
    update departments
       set key = v_key, name = v_name, sort_order = coalesce(p_sort_order, sort_order)
     where id = p_id;
  exception when unique_violation then
    raise exception 'that department key is already used' using errcode = '23505';
  end;

  if v_old.key <> v_key or v_old.name <> v_name
     or (p_sort_order is not null and v_old.sort_order <> p_sort_order) then
    perform log_admin_event(g.course_id, g.actor_id, 'settings_changed', p_id,
      jsonb_build_object('kind', 'department', 'action', 'changed',
        'from', jsonb_build_object('key', v_old.key, 'name', v_old.name, 'sort_order', v_old.sort_order),
        'to',   jsonb_build_object('key', v_key, 'name', v_name,
                                   'sort_order', coalesce(p_sort_order, v_old.sort_order))));
  end if;
  return p_id;
end;
$$;

-- --------------------------------------------------------------- mint_placard
-- Replaces a location's code. The old token stops resolving in the same
-- transaction the new one starts, so there is never a moment with two live
-- signs for one hole. Only the first six characters of either token reach the
-- audit row: the log is readable by every manager, and a full token in it is a
-- working placard.
create or replace function mint_placard(p_location_id uuid)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare g record; v_loc locations%rowtype; v_old text[]; v_token text;
begin
  select * into g from assert_can_manage(null);

  select * into v_loc from locations where id = p_location_id;
  if not found or v_loc.course_id <> g.course_id then
    raise exception 'that location is not at your club' using errcode = '42501';
  end if;
  if not v_loc.active then
    raise exception 'that location is retired; restore it before printing a sign for it'
      using errcode = '22023';
  end if;

  with retired as (
    update qr_codes set active = false
     where location_id = p_location_id and active
    returning token
  )
  select coalesce(array_agg(left(token, 6)), '{}') into v_old from retired;

  -- token takes the table default: 12 random bytes, hex.
  insert into qr_codes (course_id, location_id)
  values (g.course_id, p_location_id)
  returning token into v_token;

  perform log_admin_event(g.course_id, g.actor_id, 'placard_regenerated', p_location_id,
    jsonb_build_object('name', v_loc.name, 'retired_prefixes', to_jsonb(v_old),
                       'new_prefix', left(v_token, 6)));
  return v_token;
end;
$$;

-- ----------------------------------------------------------- get_scan_context
-- 20260903120300's body with one clause: a retired location's code no longer
-- resolves, so a sign left on a hole the club has retired says so instead of
-- filing reports nobody will find.
create or replace function get_scan_context(p_token text)
returns table (
  course_id   uuid,
  course_name text,
  course_slug text,
  settings    jsonb,
  location_id uuid,
  location_name text,
  hole_number int
)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.slug, c.settings, l.id, l.name, l.hole_number
  from qr_codes q
  join courses   c on c.id = q.course_id
  join locations l on l.id = q.location_id and l.active
  where q.token = p_token and q.active
$$;

-- ------------------------------------------------------------------- grants
-- Management-only, enforced inside each body by assert_can_manage; the grant
-- to authenticated is what lets a manager's session reach the function at all.
revoke all on function update_course_settings(text,text,text,text,text)      from public, anon;
revoke all on function upsert_location(uuid,location_kind,int,text,int)       from public, anon;
revoke all on function set_location_active(uuid,boolean)                      from public, anon;
revoke all on function upsert_department(uuid,text,text,int)                  from public, anon;
revoke all on function mint_placard(uuid)                                     from public, anon;
grant execute on function update_course_settings(text,text,text,text,text)   to authenticated;
grant execute on function upsert_location(uuid,location_kind,int,text,int)    to authenticated;
grant execute on function set_location_active(uuid,boolean)                   to authenticated;
grant execute on function upsert_department(uuid,text,text,int)               to authenticated;
grant execute on function mint_placard(uuid)                                  to authenticated;

-- The member path, restated exactly as 20260903120300 granted it.
revoke all on function get_scan_context(text) from public;
grant execute on function get_scan_context(text) to anon, authenticated;
