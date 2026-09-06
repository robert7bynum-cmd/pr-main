-- Contact details expire, and a club can be created without hand-written SQL.
--
-- The placard form collects a member's name, phone and email so the team can
-- ask a question about the report. That is the only reason it collects them,
-- and the reason stops applying a few weeks after the report is closed. Until
-- now nothing removed them: a report from March still carried the member's
-- mobile number in September, readable by every member of staff, for no
-- purpose anyone could name. The build plan promised a per-club retention
-- period after which contact details go and the report stays — the analytics
-- are about holes, categories and response times, none of which need a phone
-- number — and a privacy notice at the point of collection (app/privacy). This
-- migration is the database half of that promise.
--
-- Three changes:
--
--   update_course_settings   gains p_retention_days: 30..3650, or null for the
--                            default of 90. Stored as settings.retention_days,
--                            audited like every other setting. The five-argument
--                            signature is dropped so PostgREST sees one function
--                            and a call with the extra key cannot be ambiguous.
--
--   purge_expired()          gains a third count, contacts. For every report
--                            older than its club's retention period that still
--                            carries a name, phone or email, the three columns
--                            are set to null and ONE report_events row of type
--                            'note' records that it happened and which fields
--                            went — actor null, because nobody did this; the
--                            policy did. An anonymisation that leaves no trace
--                            is indistinguishable from a member who never gave a
--                            number, and the timeline is the record. The cron
--                            job body from 20260906110000 already calls
--                            purge_expired(), so the schedule is untouched.
--                            Adding a column to a `returns table` needs a drop
--                            and rebuild; the ACL is restated because the drop
--                            discards it.
--
--   create_club(...)         the seed is the only thing that has ever made a
--                            course. This builds one: the club row, the seven
--                            departments and ten routing rules from
--                            docs/taxonomy.md with the taxonomy's SLAs, and a
--                            pending owner whose first sign-in claims the
--                            profile. No locations — the club adds its own from
--                            the locations screen and prints them. Service role
--                            only: it is run from scripts/create-club.mts, never
--                            from a session. scripts/test-club-create.mts parses
--                            the taxonomy tables and checks the rows here
--                            against them, so the document stays the source of
--                            truth and this function cannot drift from it
--                            silently.
--
-- Re-runnable: drop if exists, then create; every grant restated.

-- ---------------------------------------------------- update_course_settings
-- 20260906130000's body with one more setting. The refusal messages and the
-- printable-address patterns are unchanged; scripts/test-placard-origin.mts
-- holds 20260906130000 to lib/placards/origin.ts, and the strings here are the
-- same two, verbatim.
drop function if exists update_course_settings(text,text,text,text,text);

create or replace function update_course_settings(
  p_name text, p_timezone text, p_public_url text, p_quiet_start text, p_quiet_end text,
  p_retention_days int default null
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
  -- asserts that 20260906130000 contains both strings exactly as that module
  -- exports them; these are the same strings.
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

  -- Retention: a month at the shortest, ten years at the longest. Null means
  -- the default of 90 days, and is stored as the absence of the key so
  -- purge_expired's coalesce is the one place the default is written down.
  if p_retention_days is not null and p_retention_days not between 30 and 3650 then
    raise exception 'contact details can be kept for between 30 and 3650 days' using errcode = '22023';
  end if;

  v_settings := v_course.settings;
  v_settings := case when v_url is null then v_settings - 'public_url'
                     else jsonb_set(v_settings, '{public_url}', to_jsonb(v_url)) end;
  v_settings := case when p_quiet_start is null then v_settings - 'quiet_hours'
                     else jsonb_set(v_settings, '{quiet_hours}',
                            jsonb_build_object('start', p_quiet_start, 'end', p_quiet_end)) end;
  v_settings := case when p_retention_days is null then v_settings - 'retention_days'
                     else jsonb_set(v_settings, '{retention_days}', to_jsonb(p_retention_days)) end;

  v_before := jsonb_build_object('name', v_course.name, 'timezone', v_course.timezone,
                                 'public_url', v_course.settings -> 'public_url',
                                 'quiet_hours', v_course.settings -> 'quiet_hours',
                                 'retention_days', v_course.settings -> 'retention_days');
  v_after  := jsonb_build_object('name', v_name, 'timezone', p_timezone,
                                 'public_url', v_settings -> 'public_url',
                                 'quiet_hours', v_settings -> 'quiet_hours',
                                 'retention_days', v_settings -> 'retention_days');

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

-- Management-only, enforced inside the body by assert_can_manage; the grant to
-- authenticated is what lets a manager's session reach the function at all.
revoke all on function update_course_settings(text,text,text,text,text,int) from public, anon;
grant execute on function update_course_settings(text,text,text,text,text,int) to authenticated;

-- ------------------------------------------------------------- purge_expired
drop function if exists purge_expired();

create function purge_expired()
returns table (nonces int, alerts int, contacts int)
language plpgsql volatile security definer set search_path = public as $$
begin
  -- A nonce is refused after two hours whatever its state; a day is generous
  -- and keeps the last few hours around for anyone reading the table by hand.
  delete from scan_nonces where issued_at < now() - interval '1 day';
  get diagnostics nonces = row_count;

  -- An alert is kept for a month after it cleared so "did the scheduler stop
  -- last week?" is still answerable. An unresolved alert is never purged.
  delete from system_alerts where resolved_at < now() - interval '30 days';
  get diagnostics alerts = row_count;

  -- Contact details. Each club's period is settings.retention_days; 90 when
  -- the club has never set one. The report itself stays — body, category,
  -- location, every event — because the metrics are about the course, not the
  -- member. One 'note' event per report says what went, so a timeline that
  -- shows no phone number is telling the truth about why.
  with due as (
    select r.id, r.course_id,
           array_remove(array[
             case when r.reporter_name  is not null then 'reporter_name'  end,
             case when r.reporter_phone is not null then 'reporter_phone' end,
             case when r.reporter_email is not null then 'reporter_email' end
           ], null) as cleared
      from reports r
      join courses c on c.id = r.course_id
     where r.created_at < now() - make_interval(days =>
             coalesce((c.settings ->> 'retention_days')::int, 90))
       and (r.reporter_name is not null
            or r.reporter_phone is not null
            or r.reporter_email is not null)
  ), cleared as (
    update reports r
       set reporter_name = null, reporter_phone = null, reporter_email = null
      from due
     where r.id = due.id
    returning due.id, due.course_id, due.cleared
  )
  insert into report_events (report_id, course_id, type, actor_id, payload)
  select id, course_id, 'note', null,
         jsonb_build_object('retention', true, 'cleared', to_jsonb(cleared))
    from cleared;
  get diagnostics contacts = row_count;

  return next;
end;
$$;

-- The owner keeps EXECUTE, which is what lets pg_cron run it. Nobody with a
-- session has any reason to purge anything.
revoke all on function purge_expired() from public, anon, authenticated;
grant execute on function purge_expired() to service_role;

-- --------------------------------------------------------------- create_club
create or replace function create_club(
  p_slug text, p_name text, p_timezone text, p_owner_email text, p_owner_name text
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_slug   text := btrim(coalesce(p_slug, ''));
  v_name   text := btrim(coalesce(p_name, ''));
  v_email  text := lower(btrim(coalesce(p_owner_email, '')));
  v_owner  text := btrim(coalesce(p_owner_name, ''));
  v_course uuid;
  v_depts  uuid[];
begin
  -- The slug is in every placard URL, so it has to be something a member's
  -- phone can be handed without escaping and a person can read off a sign.
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

  -- docs/taxonomy.md, Categories table: category, department key, ack, resolve.
  insert into routing_rules (course_id, category, department_id, ack_sla_minutes, resolve_sla_minutes)
  select v_course, t.category, d.id, t.ack, t.resolve
    from (values
      ('pace_of_play',        'pace_of_play', 10, 30),
      ('course_maintenance',  'maintenance',  15, 240),
      ('cart_issue',          'cart_fleet',   10, 45),
      ('pro_shop',            'pro_shop',     15, 60),
      ('f_and_b',             'f_and_b',      10, 30),
      ('restroom_facilities', 'maintenance',  20, 120),
      ('practice_facility',   'pro_shop',     30, 240),
      ('safety',              'management',    5, 30),
      ('caddie_valet',        'caddie',       10, 30),
      ('needs_review',        'management',   15, 120)
    ) as t(category, dept_key, ack, resolve)
    join departments d on d.course_id = v_course and d.key = t.dept_key;

  -- The owner sees the whole course, the way invite.mts scopes a manager.
  -- claim_profile turns this row into a profile on their first sign-in.
  select array_agg(id order by sort_order) into v_depts from departments where course_id = v_course;
  insert into pending_profiles (course_id, email, full_name, role, department_ids)
  values (v_course, v_email, v_owner, 'owner', v_depts);

  -- No actor: this ran from the command line, before the club had anyone.
  perform log_admin_event(v_course, null, 'settings_changed', v_course,
    jsonb_build_object('event', 'club_created', 'slug', v_slug, 'owner_email', v_email));

  return v_course;
end;
$$;

-- Service role only. There is no session that should be able to create a
-- club, and the grant is how a reader knows the caller is the script.
revoke all on function create_club(text,text,text,text,text) from public, anon, authenticated;
grant execute on function create_club(text,text,text,text,text) to service_role;
