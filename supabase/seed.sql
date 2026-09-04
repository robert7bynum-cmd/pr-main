-- =====================================================================
-- ProResponse demo seed — Beacon Hill Golf Club
-- =====================================================================
-- Populates one fully-fleshed demo club: course, holes/locations, QR
-- placards, departments, an eight-person staff roster, routing rules,
-- and ~6 weeks of realistic historical report activity with a matching
-- event trail. Safe to run over and over — the first block deletes any
-- prior copy of this demo club (by slug) and everything cascades from
-- there, so re-running never duplicates rows.
--
-- All hand-written UUIDs below follow a simple, readable numbering
-- scheme so the file stays easy to audit:
--   a0000000-...-NN  locations (holes 01-18, then 19-24 for the rest)
--   b0000000-...-NN  qr_codes  (same NN as the location they belong to)
--   c0000000-...-01  the course itself / ...-10 the one venue
--   d0000000-...-N   departments (1-7)
--   e0000000-...-N   staff (auth.users + profiles share the same id, 1-9)
--   f0000000-...-N   routing_rules (1-10, one per taxonomy category)
--
-- The historical reports (block 8) are generated with generate_series()
-- and random() rather than hand-written, per spec. setseed(0.42) pins
-- the PRNG so the generated history — category mix, hole hot-spots,
-- response times, wording — is identical every time this file runs.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Clear out any previous copy of this demo club.
-- ---------------------------------------------------------------------
-- Every domain table carries course_id with on delete cascade back to
-- courses, so deleting the course by its fixed slug clears venues,
-- locations, qr_codes, departments, profiles, staff_departments,
-- routing_rules, reports, report_events, triage_queue and notifications
-- in one shot. auth.users rows are NOT touched by this cascade (Postgres
-- doesn't let a public-schema FK cascade into auth), so those are
-- upserted with `on conflict do nothing` further down instead.
delete from courses where slug = 'beacon-hill';

drop table if exists seed_reports;

-- ---------------------------------------------------------------------
-- 1. The club
-- ---------------------------------------------------------------------
insert into courses (id, slug, name, timezone, is_demo, settings, created_at)
values (
  'c0000000-0000-0000-0000-000000000001',
  'beacon-hill',
  'Beacon Hill Golf Club',
  'America/New_York',
  true,
  '{"branding":{"primary":"#E2AF47","ink":"#111111","surface":"#FFFFFF","logo_url":null},"quiet_hours":{"start":"20:00","end":"06:00"}}'::jsonb,
  now() - interval '400 days'
)
on conflict (id) do nothing;

insert into venues (id, course_id, name, sort_order)
values (
  'c0000000-0000-0000-0000-000000000010',
  'c0000000-0000-0000-0000-000000000001',
  'Beacon Hill Golf Club',
  0
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. Locations — 18 holes plus the rest of the property.
-- ---------------------------------------------------------------------
-- Holes 1-18 via generate_series to avoid 18 near-identical lines.
insert into locations (id, course_id, venue_id, kind, hole_number, name, sort_order, created_at)
select
  ('a0000000-0000-0000-0000-0000000000' || lpad(h::text, 2, '0'))::uuid,
  'c0000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000010',
  'hole'::location_kind,
  h,
  'Hole ' || h,
  h,
  now() - interval '400 days'
from generate_series(1, 18) as h
on conflict (id) do nothing;

-- The rest of the property: range, clubhouse, cart barn, halfway house,
-- and two restrooms (one near the front nine turn, one near the back).
insert into locations (id, course_id, venue_id, kind, hole_number, name, sort_order, created_at)
values
  ('a0000000-0000-0000-0000-000000000019', 'c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000010', 'practice'::location_kind,      null, 'Practice Range',       19, now() - interval '400 days'),
  ('a0000000-0000-0000-0000-000000000020', 'c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000010', 'clubhouse'::location_kind,     null, 'Clubhouse',            20, now() - interval '400 days'),
  ('a0000000-0000-0000-0000-000000000021', 'c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000010', 'cart_barn'::location_kind,     null, 'Cart Barn',            21, now() - interval '400 days'),
  ('a0000000-0000-0000-0000-000000000022', 'c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000010', 'halfway_house'::location_kind, null, 'Halfway House',        22, now() - interval '400 days'),
  ('a0000000-0000-0000-0000-000000000023', 'c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000010', 'restroom'::location_kind,      null, 'Restroom — Hole 6',    23, now() - interval '400 days'),
  ('a0000000-0000-0000-0000-000000000024', 'c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000010', 'restroom'::location_kind,      null, 'Restroom — Hole 13',   24, now() - interval '400 days')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 3. QR placards — one active code per location, readable fixed tokens.
-- ---------------------------------------------------------------------
insert into qr_codes (id, course_id, location_id, token, active, printed_at, created_at)
select
  ('b0000000-0000-0000-0000-0000000000' || lpad(h::text, 2, '0'))::uuid,
  'c0000000-0000-0000-0000-000000000001',
  ('a0000000-0000-0000-0000-0000000000' || lpad(h::text, 2, '0'))::uuid,
  'bh-h' || lpad(h::text, 2, '0'),
  true,
  now() - interval '390 days',
  now() - interval '390 days'
from generate_series(1, 18) as h
on conflict (id) do nothing;

insert into qr_codes (id, course_id, location_id, token, active, printed_at, created_at)
values
  ('b0000000-0000-0000-0000-000000000019', 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000019', 'bh-range',        true, now() - interval '390 days', now() - interval '390 days'),
  ('b0000000-0000-0000-0000-000000000020', 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000020', 'bh-clubhouse',    true, now() - interval '390 days', now() - interval '390 days'),
  ('b0000000-0000-0000-0000-000000000021', 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000021', 'bh-cartbarn',     true, now() - interval '390 days', now() - interval '390 days'),
  ('b0000000-0000-0000-0000-000000000022', 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000022', 'bh-halfway',      true, now() - interval '390 days', now() - interval '390 days'),
  ('b0000000-0000-0000-0000-000000000023', 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000023', 'bh-restroom-6',   true, now() - interval '390 days', now() - interval '390 days'),
  ('b0000000-0000-0000-0000-000000000024', 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000024', 'bh-restroom-13',  true, now() - interval '390 days', now() - interval '390 days')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 4. Departments — exactly the seven from docs/taxonomy.md.
-- ---------------------------------------------------------------------
insert into departments (id, course_id, key, name, sort_order)
values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'maintenance',  'Course Maintenance', 1),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'cart_fleet',   'Cart Fleet',         2),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 'pro_shop',     'Pro Shop',           3),
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001', 'pace_of_play', 'Player Assistance',  4),
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001', 'f_and_b',      'Food & Beverage',    5),
  ('d0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001', 'caddie',       'Caddie & Valet',     6),
  ('d0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000001', 'management',   'Management',        7)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 5. Staff — a small crew of nine, matching a club this size.
-- ---------------------------------------------------------------------
-- profiles.id references auth.users(id), so each person needs a minimal
-- auth.users row first. Only the columns the task calls for are
-- populated; everything else on auth.users has a workable default.
insert into auth.users (id, instance_id, email, created_at, updated_at, aud, role)
values
  ('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'swhitfield@beaconhillgolfva.com', now() - interval '380 days', now() - interval '380 days', 'authenticated', 'authenticated'),
  ('e0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'cdonnelly@beaconhillgolfva.com',  now() - interval '380 days', now() - interval '380 days', 'authenticated', 'authenticated'),
  ('e0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'malvarez@beaconhillgolfva.com',   now() - interval '380 days', now() - interval '380 days', 'authenticated', 'authenticated'),
  ('e0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'tsinclair@beaconhillgolfva.com',  now() - interval '380 days', now() - interval '380 days', 'authenticated', 'authenticated'),
  ('e0000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'ereyes@beaconhillgolfva.com',     now() - interval '380 days', now() - interval '380 days', 'authenticated', 'authenticated'),
  ('e0000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'jmartinez@beaconhillgolfva.com',  now() - interval '380 days', now() - interval '380 days', 'authenticated', 'authenticated'),
  ('e0000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000000', 'dcarter@beaconhillgolfva.com',    now() - interval '380 days', now() - interval '380 days', 'authenticated', 'authenticated'),
  ('e0000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000000', 'anguyen@beaconhillgolfva.com',    now() - interval '380 days', now() - interval '380 days', 'authenticated', 'authenticated'),
  ('e0000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000000', 'proshop@beaconhillgolfva.com',    now() - interval '380 days', now() - interval '380 days', 'authenticated', 'authenticated')
on conflict (id) do nothing;

-- Role mix: one manager (GM), one owner-level director, two supervisors
-- (superintendent, head pro), four staff, plus one shared station login
-- for the pro shop counter. Roughly half on_duty right now.
insert into profiles (id, course_id, full_name, email, phone, role, account_kind, preferred_language, on_duty, on_duty_since, active, created_at)
values
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'Sarah Whitfield',      'swhitfield@beaconhillgolfva.com', '571-555-0101', 'manager'::staff_role,    'individual'::account_kind, 'en', false, null,                        true, now() - interval '380 days'),
  ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'Craig Donnelly',       'cdonnelly@beaconhillgolfva.com',  '571-555-0102', 'owner'::staff_role,      'individual'::account_kind, 'en', false, null,                        true, now() - interval '380 days'),
  ('e0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 'Miguel Alvarez',       'malvarez@beaconhillgolfva.com',   '571-555-0103', 'supervisor'::staff_role, 'individual'::account_kind, 'en', true,  now() - interval '3 hours', true, now() - interval '380 days'),
  ('e0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001', 'Tommy Sinclair',       'tsinclair@beaconhillgolfva.com',  '571-555-0104', 'supervisor'::staff_role, 'individual'::account_kind, 'en', true,  now() - interval '2 hours', true, now() - interval '380 days'),
  ('e0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001', 'Efrain Reyes',         'ereyes@beaconhillgolfva.com',     '571-555-0105', 'staff'::staff_role,      'individual'::account_kind, 'es', true,  now() - interval '4 hours', true, now() - interval '370 days'),
  ('e0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001', 'Jose Luis Martinez',   'jmartinez@beaconhillgolfva.com',  '571-555-0106', 'staff'::staff_role,      'individual'::account_kind, 'es', false, null,                        true, now() - interval '360 days'),
  ('e0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000001', 'Dylan Carter',         'dcarter@beaconhillgolfva.com',    '571-555-0107', 'staff'::staff_role,      'individual'::account_kind, 'en', true,  now() - interval '1 hours', true, now() - interval '350 days'),
  ('e0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000001', 'Ashley Nguyen',        'anguyen@beaconhillgolfva.com',    '571-555-0108', 'staff'::staff_role,      'individual'::account_kind, 'en', false, null,                        true, now() - interval '340 days'),
  ('e0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000001', 'Pro Shop Counter',     'proshop@beaconhillgolfva.com',    null,           'staff'::staff_role,      'station'::account_kind,    'en', true,  now() - interval '5 hours', true, now() - interval '380 days')
on conflict (id) do nothing;

-- Wire every department to at least one staff member.
insert into staff_departments (profile_id, department_id)
values
  -- Sarah Whitfield (GM) — management
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000007'),
  -- Craig Donnelly (Director of Golf Operations) — management, pro shop
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000007'),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000003'),
  -- Miguel Alvarez (Superintendent) — maintenance
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001'),
  -- Tommy Sinclair (Head Golf Professional) — pro shop, player assistance
  ('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000003'),
  ('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000004'),
  -- Efrain Reyes (Grounds Crew) — maintenance
  ('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000001'),
  -- Jose Luis Martinez (Grounds Crew) — maintenance
  ('e0000000-0000-0000-0000-000000000006', 'd0000000-0000-0000-0000-000000000001'),
  -- Dylan Carter (Cart Fleet Attendant) — cart fleet
  ('e0000000-0000-0000-0000-000000000007', 'd0000000-0000-0000-0000-000000000002'),
  -- Ashley Nguyen (F&B / Caddie & Valet Lead) — food & beverage, caddie
  ('e0000000-0000-0000-0000-000000000008', 'd0000000-0000-0000-0000-000000000005'),
  ('e0000000-0000-0000-0000-000000000008', 'd0000000-0000-0000-0000-000000000006'),
  -- Pro Shop Counter (station) — pro shop
  ('e0000000-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000003')
on conflict (profile_id, department_id) do nothing;

-- ---------------------------------------------------------------------
-- 6. Routing rules — one per taxonomy category, exact SLA values.
-- ---------------------------------------------------------------------
insert into routing_rules (id, course_id, category, department_id, ack_sla_minutes, resolve_sla_minutes, requires_photo)
values
  ('f0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'pace_of_play',        'd0000000-0000-0000-0000-000000000004', 10, 30,  false),
  ('f0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'course_maintenance',  'd0000000-0000-0000-0000-000000000001', 15, 240, false),
  ('f0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 'cart_issue',          'd0000000-0000-0000-0000-000000000002', 10, 45,  false),
  ('f0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001', 'pro_shop',            'd0000000-0000-0000-0000-000000000003', 15, 60,  false),
  ('f0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001', 'f_and_b',             'd0000000-0000-0000-0000-000000000005', 10, 30,  false),
  ('f0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001', 'restroom_facilities', 'd0000000-0000-0000-0000-000000000001', 20, 120, false),
  ('f0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000001', 'practice_facility',   'd0000000-0000-0000-0000-000000000003', 30, 240, false),
  ('f0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000001', 'safety',              'd0000000-0000-0000-0000-000000000007', 5,  30,  false),
  ('f0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000001', 'caddie_valet',        'd0000000-0000-0000-0000-000000000006', 10, 30,  false),
  ('f0000000-0000-0000-0000-000000000010', 'c0000000-0000-0000-0000-000000000001', 'needs_review',        'd0000000-0000-0000-0000-000000000007', 15, 120, false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 7-9. Historical reports, their event trails, and triage_queue rows.
-- ---------------------------------------------------------------------
-- ~6 weeks of history ending TODAY (current_date at the time this file
-- is run, not a hardcoded date — so the demo always looks current, even
-- if re-run on a different day than it was written). setseed(0.42) pins
-- the PRNG so the mix of categories, hole hot-spots, timing and wording
-- comes out identical on every run. max_parallel_workers_per_gather is
-- forced to 0 for this transaction so Postgres can't reorder row
-- generation across parallel workers and break that determinism.
select setseed(0.42);
set local max_parallel_workers_per_gather = 0;

create temp table seed_reports as
with
-- One row per report we're about to synthesize. 220 lands in the
-- middle of the 180-260 range the spec asks for.
report_n as materialized (
  select gs as n from generate_series(1, 220) as gs
),
-- The 42 calendar days of the window, tagged with day-of-week so we can
-- draw weekend days (Fri/Sat/Sun) more often than weekdays.
days as materialized (
  select d::date as day, extract(dow from d)::int as dow
  from generate_series((current_date - interval '41 days')::timestamp, current_date::timestamp, interval '1 day') as d
),
weekend_pool as materialized (
  select array_agg(day order by day) as arr from days where dow in (0, 5, 6)   -- Sun, Fri, Sat
),
weekday_pool as materialized (
  select array_agg(day order by day) as arr from days where dow not in (0, 5, 6)
),
-- The 18 hole location ids, for picking "somewhere on the course".
hole_ids as materialized (
  select array_agg(('a0000000-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid order by g) as arr
  from generate_series(1, 18) as g
),
restroom_ids as materialized (
  select array['a0000000-0000-0000-0000-000000000023'::uuid, 'a0000000-0000-0000-0000-000000000024'::uuid] as arr
),

-- ---- category: weighted so course_maintenance and pace_of_play lead,
-- cart_issue and f_and_b are next most common, safety is rare.
cat_pick as materialized (
  select n,
    case
      when r < 0.24 then 'course_maintenance'
      when r < 0.46 then 'pace_of_play'
      when r < 0.59 then 'cart_issue'
      when r < 0.71 then 'f_and_b'
      when r < 0.79 then 'restroom_facilities'
      when r < 0.86 then 'pro_shop'
      when r < 0.91 then 'practice_facility'
      when r < 0.95 then 'caddie_valet'
      when r < 0.98 then 'needs_review'
      else 'safety'
    end as category
  from (select n, random() as r from report_n) s
),

-- ---- location: most categories point at a plausible spot; course
-- maintenance is deliberately weighted onto holes 4 and 12 (irrigation)
-- and hole 7 (cart path) so the recurring-problem view has something
-- real to surface.
loc_pick as materialized (
  select cp.n, cp.category, rnd.r2,
    case cp.category
      when 'course_maintenance' then
        case
          when rnd.r2 < 0.35 then 'a0000000-0000-0000-0000-000000000004'::uuid   -- hole 4, irrigation
          when rnd.r2 < 0.55 then 'a0000000-0000-0000-0000-000000000012'::uuid   -- hole 12, irrigation
          when rnd.r2 < 0.72 then 'a0000000-0000-0000-0000-000000000007'::uuid   -- hole 7, cart path
          else (select h.arr[1 + floor(random() * 18)::int] from hole_ids h)
        end
      when 'restroom_facilities' then
        (select r.arr[1 + floor(rnd.r2 * 2)::int] from restroom_ids r)
      when 'cart_issue' then
        case when rnd.r2 < 0.6 then 'a0000000-0000-0000-0000-000000000021'::uuid  -- cart barn
             else (select h.arr[1 + floor(random() * 18)::int] from hole_ids h) end
      when 'f_and_b' then
        case when rnd.r2 < 0.5 then 'a0000000-0000-0000-0000-000000000022'::uuid  -- halfway house
             when rnd.r2 < 0.75 then 'a0000000-0000-0000-0000-000000000020'::uuid -- clubhouse
             else (select h.arr[1 + floor(random() * 18)::int] from hole_ids h) end
      when 'caddie_valet' then
        case when rnd.r2 < 0.7 then 'a0000000-0000-0000-0000-000000000020'::uuid  -- clubhouse
             else 'a0000000-0000-0000-0000-000000000021'::uuid end                -- cart barn
      when 'safety' then
        case when rnd.r2 < 0.8 then (select h.arr[1 + floor(random() * 18)::int] from hole_ids h)
             else 'a0000000-0000-0000-0000-000000000021'::uuid end
      when 'practice_facility' then 'a0000000-0000-0000-0000-000000000019'::uuid  -- range
      when 'pro_shop' then 'a0000000-0000-0000-0000-000000000020'::uuid           -- clubhouse
      else (select h.arr[1 + floor(random() * 18)::int] from hole_ids h)          -- pace_of_play, needs_review
    end as location_id
  from cat_pick cp, lateral (select random() as r2) rnd
),
-- qr_code_id mirrors location_id: same trailing two digits, 'b' prefix
-- instead of 'a' — matches the numbering used for the qr_codes insert
-- above, so this always points at a real, active placard.
loc_pick2 as materialized (
  select n, category, location_id,
    ('b0000000-0000-0000-0000-0000000000' || right(location_id::text, 2))::uuid as qr_code_id
  from loc_pick
),

-- ---- when: two tee-time waves (morning 7-11, afternoon 1-5), almost
-- nothing overnight, and weekends busier than weekdays.
when_pick as materialized (
  select lp.*,
    case when rnd.r_wk < 0.55
         then (select w.arr[1 + floor(random() * array_length(w.arr, 1))::int] from weekend_pool w)
         else (select d.arr[1 + floor(random() * array_length(d.arr, 1))::int] from weekday_pool d)
    end as report_date,
    case
      when rnd.r_tod < 0.48 then 7  + floor(rnd.r_h * 5)::int   -- 7-11am wave
      when rnd.r_tod < 0.90 then 13 + floor(rnd.r_h * 5)::int   -- 1-5pm wave
      when rnd.r_tod < 0.97 then 11 + floor(rnd.r_h * 2)::int   -- lunch lull
      else floor(rnd.r_h * 7)::int                              -- rare overnight/early
    end as report_hour,
    floor(random() * 60)::int as report_minute,
    floor(random() * 60)::int as report_second
  from loc_pick2 lp,
       lateral (select random() as r_wk, random() as r_tod, random() as r_h) rnd
),

-- ---- SLA + department: hardcoded from docs/taxonomy.md, keyed by category.
sla_pick as materialized (
  select wp.*,
    case wp.category
      when 'course_maintenance'  then 'd0000000-0000-0000-0000-000000000001'::uuid
      when 'restroom_facilities' then 'd0000000-0000-0000-0000-000000000001'::uuid
      when 'cart_issue'          then 'd0000000-0000-0000-0000-000000000002'::uuid
      when 'pro_shop'            then 'd0000000-0000-0000-0000-000000000003'::uuid
      when 'practice_facility'   then 'd0000000-0000-0000-0000-000000000003'::uuid
      when 'pace_of_play'        then 'd0000000-0000-0000-0000-000000000004'::uuid
      when 'f_and_b'             then 'd0000000-0000-0000-0000-000000000005'::uuid
      when 'caddie_valet'        then 'd0000000-0000-0000-0000-000000000006'::uuid
      when 'safety'              then 'd0000000-0000-0000-0000-000000000007'::uuid
      when 'needs_review'        then 'd0000000-0000-0000-0000-000000000007'::uuid
    end as department_id,
    case wp.category
      when 'pace_of_play' then 10 when 'course_maintenance' then 15 when 'cart_issue' then 10
      when 'pro_shop' then 15 when 'f_and_b' then 10 when 'restroom_facilities' then 20
      when 'practice_facility' then 30 when 'safety' then 5 when 'caddie_valet' then 10
      when 'needs_review' then 15
    end as ack_sla,
    case wp.category
      when 'pace_of_play' then 30 when 'course_maintenance' then 240 when 'cart_issue' then 45
      when 'pro_shop' then 60 when 'f_and_b' then 30 when 'restroom_facilities' then 120
      when 'practice_facility' then 240 when 'safety' then 30 when 'caddie_valet' then 30
      when 'needs_review' then 120
    end as resolve_sla,
    -- Who would plausibly own this category. Never the station account.
    case wp.category
      when 'course_maintenance'  then (array['e0000000-0000-0000-0000-000000000003','e0000000-0000-0000-0000-000000000005','e0000000-0000-0000-0000-000000000006']::uuid[])[1 + floor(random() * 3)::int]
      when 'restroom_facilities' then (array['e0000000-0000-0000-0000-000000000003','e0000000-0000-0000-0000-000000000005','e0000000-0000-0000-0000-000000000006']::uuid[])[1 + floor(random() * 3)::int]
      when 'cart_issue'          then (array['e0000000-0000-0000-0000-000000000007','e0000000-0000-0000-0000-000000000003']::uuid[])[1 + floor(random() * 2)::int]
      when 'pro_shop'            then (array['e0000000-0000-0000-0000-000000000004','e0000000-0000-0000-0000-000000000002']::uuid[])[1 + floor(random() * 2)::int]
      when 'practice_facility'   then (array['e0000000-0000-0000-0000-000000000004','e0000000-0000-0000-0000-000000000002']::uuid[])[1 + floor(random() * 2)::int]
      when 'f_and_b'             then 'e0000000-0000-0000-0000-000000000008'::uuid
      when 'caddie_valet'        then (array['e0000000-0000-0000-0000-000000000008','e0000000-0000-0000-0000-000000000004']::uuid[])[1 + floor(random() * 2)::int]
      when 'pace_of_play'        then (array['e0000000-0000-0000-0000-000000000004','e0000000-0000-0000-0000-000000000001']::uuid[])[1 + floor(random() * 2)::int]
      when 'safety'              then (array['e0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000002']::uuid[])[1 + floor(random() * 2)::int]
      when 'needs_review'        then (array['e0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000002']::uuid[])[1 + floor(random() * 2)::int]
    end as assignee_id
  from when_pick wp
),

-- ---- status + timestamps. ~85% resolved, a handful closed with no
-- action, a few still open, a couple scheduled for a future date. Ack
-- and resolve times mostly beat the SLA, a believable minority breach
-- it. Everything is clamped so acknowledged_at < resolved_at < now().
status_pick as materialized (
  select sp.*,
    (sp.report_date::timestamp
       + make_interval(hours => sp.report_hour, mins => sp.report_minute, secs => sp.report_second)
    ) at time zone 'America/New_York' as created_at_raw,
    rnd.r_status, rnd.r_ack, rnd.r_resolve, rnd.r_close
  from sla_pick sp,
       lateral (select random() as r_status, random() as r_ack, random() as r_resolve, random() as r_close) rnd
),
status_pick2 as materialized (
  select sp.*,
    least(sp.created_at_raw, now() - interval '2 hours') as created_at,
    -- Raw status draw; anything still "open" that was filed more than a
    -- week ago gets folded into resolved/closed, since a real club would
    -- have worked through it by now. Reports from the last 7 days keep a
    -- realistic in-flight mix so the demo has live tickets to show, not
    -- just history.
    case
      when sp.created_at_raw < now() - interval '7 days' then
        case when sp.r_status < 0.92 then 'resolved' else 'closed_no_action' end
      else
        case
          when sp.r_status < 0.55 then 'resolved'
          when sp.r_status < 0.65 then 'closed_no_action'
          when sp.r_status < 0.78 then 'acknowledged'
          when sp.r_status < 0.88 then 'in_progress'
          when sp.r_status < 0.95 then 'scheduled'
          else 'new'
        end
    end::report_status as status
  from status_pick sp
),
status_pick3 as materialized (
  select sp.*,
    -- ack offset: on time ~85% of the time, a believable breach otherwise.
    -- All arithmetic here is deliberately kept in plain int/float8 (no bare
    -- decimal literals mixed with float8) so operator resolution is unambiguous.
    (case when sp.r_ack < 0.85
          then 1 + floor(random() * greatest((sp.ack_sla * 9)::float8 / 10, 1))::int
          else round(sp.ack_sla::numeric * 1.2)::int + floor(random() * greatest((sp.ack_sla * 2)::float8, 1))::int
     end) as ack_minutes,
    sp.r_ack < 0.85 as ack_on_time,
    -- resolve offset (measured from acknowledgment): on time ~80%.
    (case when sp.r_resolve < 0.80
          then 5 + floor(random() * greatest((sp.resolve_sla * 9)::float8 / 10, 1))::int
          else round(sp.resolve_sla::numeric * 1.2)::int + floor(random() * greatest((sp.resolve_sla * 2)::float8, 1))::int
     end) as resolve_minutes,
    sp.r_resolve < 0.80 as resolve_on_time
  from status_pick2 sp
),
status_pick4 as materialized (
  select sp.*,
    case when sp.status <> 'new'
         then least(sp.created_at + (sp.ack_minutes || ' minutes')::interval, now() - interval '1 hour')
         else null end as acknowledged_at_pre
  from status_pick3 sp
),
status_pick5 as materialized (
  select sp.*,
    case when sp.status in ('resolved', 'closed_no_action')
         then least(sp.acknowledged_at_pre + (sp.resolve_minutes || ' minutes')::interval, now() - interval '5 minutes')
         else null end as resolved_at_pre
  from status_pick4 sp
),
status_pick6 as materialized (
  select sp.*,
    -- scheduled work gets a target date a few days out from "today".
    case when sp.status = 'scheduled' then current_date + (1 + floor(random() * 5))::int else null end as scheduled_for_pre,
    case when sp.status = 'closed_no_action' then
      (case when sp.r_close < 0.6 then 'no_action_needed' when sp.r_close < 0.85 then 'invalid' else 'duplicate' end)::close_reason
      else null end as close_reason_pre,
    case when sp.status in ('resolved', 'closed_no_action') and (not sp.ack_on_time or not sp.resolve_on_time)
         then 1 else 0 end as escalation_level_pre,
    case when sp.status = 'resolved' then random() < 0.35 else null end as resolved_on_site_pre
  from status_pick5 sp
),

-- ---- reported-by, source, urgency, confidence, triage metadata.
meta_pick as materialized (
  select sp.*,
    case when rnd.r_src < 0.90 then 'member_qr' when rnd.r_src < 0.98 then 'staff' else 'phone_relay' end::report_source as source,
    case when rnd.r_tri < 0.85 then 'model' when rnd.r_tri < 0.95 then 'keyword' else 'manual' end::triage_source as triage_source,
    round((55 + random() * 44)::numeric / 100, 2) as ai_confidence,
    case sp.category
      when 'safety' then (case when random() < 0.7 then 'high' else 'urgent' end)
      when 'pace_of_play' then (case when random() < 0.75 then 'normal' else 'high' end)
      when 'course_maintenance' then (case when random() < 0.3 then 'low' else 'normal' end)
      when 'restroom_facilities' then (case when random() < 0.3 then 'low' else 'normal' end)
      when 'practice_facility' then (case when random() < 0.3 then 'low' else 'normal' end)
      else (case when random() < 0.2 then 'low' else 'normal' end)
    end::report_urgency as urgency,
    (array['James Whitaker','Karen Doyle','Tom Bridges','Linda Park','Frank DeLuca','Nancy Sorensen',
           'Bill Aldridge','Carol Mensah','Rich Delgado','Pat Sung','Dan Marchetti','Grace Lindqvist',
           'Steve Novak','Ellen Piper','Marty Rourke','Diane Castellano']::text[])[1 + floor(random() * 16)::int] as reporter_name_pool,
    random() < 0.75 as has_reporter_name,
    random() < 0.4 as has_phone,
    random() < 0.5 as has_member_no,
    case when random() < 0.9 then 'en' else 'es' end as reporter_language
  from status_pick6 sp,
       lateral (select random() as r_src, random() as r_tri) rnd
),

-- ---- body copy, ai_summary, internal note, member-facing message.
content_pick as materialized (
  select mp.*,
    case
      when mp.category = 'course_maintenance' and mp.location_id in ('a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000012') then
        (array['Sprinkler head is stuck on and has flooded part of the fairway.',
               'Standing water by the green, looks like a broken irrigation line.',
               'Ground is soaked and mushy off to the side, sprinklers running too long.',
               'One of the sprinkler heads is broken off and spraying sideways.',
               'Wet, squishy turf right where we are trying to land approach shots.']::text[])[1 + floor(random()*5)::int]
      when mp.category = 'course_maintenance' and mp.location_id = 'a0000000-0000-0000-0000-000000000007' then
        (array['Cart path is cracked with a pothole that jars the cart pretty bad.',
               'Chunk of the cart path is crumbling away near the turn.',
               'Cart path edge has washed out, hard to tell where the path even is anymore.',
               'Big crack running across the cart path, could use a repair.']::text[])[1 + floor(random()*4)::int]
      when mp.category = 'course_maintenance' then
        (array['Bunker on the left side is in rough shape, hardly any sand left.',
               'Big divot patch in front of the green that never got seeded.',
               'Tree branch down near the cart path, might want to move it before someone hits it.',
               'Rough has not been cut out here in what feels like two weeks.',
               'Ball washer is broken and full of dirty water.',
               'Fairway has some bare, sandy patches on the approach.']::text[])[1 + floor(random()*6)::int]
      when mp.category = 'pace_of_play' then
        (array['We have been waiting almost 20 minutes on this tee, group ahead is backed up.',
               'Foursome in front of us is playing very slow, nobody behind them either.',
               'Been standing on this fairway forever waiting for the green to clear.',
               'Course is playing really slow today, we are already an hour behind.',
               'Group ahead keeps looking for lost balls, holding everyone up.']::text[])[1 + floor(random()*5)::int]
      when mp.category = 'cart_issue' then
        (array['Cart 14 will not start, battery seems dead.',
               'GPS screen on our cart is frozen and will not reset.',
               'Cart is making a grinding noise when we brake.',
               'Basket on the cart is broken and rattling around.',
               'Cart tire looks low, riding really rough.']::text[])[1 + floor(random()*5)::int]
      when mp.category = 'f_and_b' then
        (array['Halfway house is out of water bottles again.',
               'Beverage cart has not come by in over an hour.',
               'Grill at the turn is out of order.',
               'They were out of the sandwiches we wanted at the turn.',
               'No ice at the halfway house drink station.']::text[])[1 + floor(random()*5)::int]
      when mp.category = 'restroom_facilities' then
        (array['Restroom is out of paper towels.',
               'Toilet is not flushing properly.',
               'Sink is clogged and will not drain.',
               'Restroom could use a cleaning, trash is overflowing.',
               'Door lock on the restroom is broken.']::text[])[1 + floor(random()*5)::int]
      when mp.category = 'pro_shop' then
        (array['Line at the pro shop counter was pretty long at checkout.',
               'They did not have my size in the shirt I wanted.',
               'Rental clubs I was given were missing a couple of irons.',
               'Scorecard printer at the desk was out of paper.']::text[])[1 + floor(random()*4)::int]
      when mp.category = 'practice_facility' then
        (array['Range mats are worn through in a couple of the stalls.',
               'Practice green has some bumpy, thin spots.',
               'Ball machine on the range keeps jamming.',
               'Not many range balls left in the buckets this morning.']::text[])[1 + floor(random()*4)::int]
      when mp.category = 'safety' then
        (array['Saw a cart parked too close to the path edge on a slope, looked like it could tip.',
               'There is a hole in the ground near the cart path, twisted my ankle a bit.',
               'Lightning looked close, wanted staff to know we are heading in.',
               'A branch came down right near the tee box, could hit someone.']::text[])[1 + floor(random()*4)::int]
      when mp.category = 'caddie_valet' then
        (array['Valet took a while to bring our clubs around after the round.',
               'Our caddie seemed unsure about the yardages on the back nine.',
               'Bag drop was unattended when we pulled up.',
               'Caddie was great but we waited a bit to get paired up.']::text[])[1 + floor(random()*4)::int]
      else
        (array['Something seems off with the setup on this hole today.',
               'Not sure who to tell but wanted to flag this.',
               'General note about conditions today.',
               'Just leaving a note, nothing urgent.']::text[])[1 + floor(random()*4)::int]
    end as body,
    case
      when mp.category = 'course_maintenance' and mp.location_id in ('a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000012') then 'Irrigation issue near green'
      when mp.category = 'course_maintenance' and mp.location_id = 'a0000000-0000-0000-0000-000000000007' then 'Cart path damage reported'
      when mp.category = 'course_maintenance'  then 'Course maintenance issue reported'
      when mp.category = 'pace_of_play'        then 'Pace of play concern'
      when mp.category = 'cart_issue'          then 'Cart mechanical issue'
      when mp.category = 'f_and_b'             then 'Food and beverage service issue'
      when mp.category = 'restroom_facilities' then 'Restroom facility issue'
      when mp.category = 'pro_shop'            then 'Pro shop service note'
      when mp.category = 'practice_facility'   then 'Practice facility condition note'
      when mp.category = 'safety'              then 'Safety concern flagged'
      when mp.category = 'caddie_valet'        then 'Caddie or valet service note'
      else 'Unclear report needs staff review'
    end as ai_summary,
    case when mp.status not in ('resolved','closed_no_action') then null else
      case
        when mp.category = 'course_maintenance' and mp.location_id in ('a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000012') then
          (array['Shut off the head, valve was stuck, swapped the solenoid.',
                 'Line was cracked below grade, cut and coupled it.',
                 'Reset controller zone timing, was overwatering that zone.',
                 'Head was sheared off, replaced and adjusted the arc.']::text[])[1 + floor(random()*4)::int]
        when mp.category = 'course_maintenance' and mp.location_id = 'a0000000-0000-0000-0000-000000000007' then
          (array['Patched the pothole with cold mix, full repave needed next season.',
                 'Filled the washout with gravel and tamped it down.',
                 'Flagged for the paving contractor, temp patch in for now.']::text[])[1 + floor(random()*3)::int]
        when mp.category = 'course_maintenance' then
          (array['Filled and reseeded, back on the mowing rotation.',
                 'Bunker raked and topped off with sand, added to weekly list.',
                 'Cleared the branch, added to Tuesday cleanup route.',
                 'Bumped the mow schedule up, crew was behind due to rain.',
                 'Ball washer swapped, old one was leaking.']::text[])[1 + floor(random()*5)::int]
        when mp.category = 'pace_of_play' then
          (array['Marshal sent up to move the group along.',
                 'Talked to the group ahead, asked them to keep pace.',
                 'Ranger flagged them at the turn.',
                 'Gap closed on its own by the next hole, no action needed.']::text[])[1 + floor(random()*4)::int]
        when mp.category = 'cart_issue' then
          (array['Swapped the battery, back in rotation.',
                 'Reset the GPS unit, rebooted fine.',
                 'Sent the cart in for a brake check.',
                 'Basket rebolted.',
                 'Aired the tire up, no puncture found.']::text[])[1 + floor(random()*5)::int]
        when mp.category = 'f_and_b' then
          (array['Restocked the halfway house.',
                 'Beverage cart driver was on break, back on route now.',
                 'Grill breaker had tripped, reset and running.',
                 'Ordered more ice for the cooler.']::text[])[1 + floor(random()*4)::int]
        when mp.category = 'restroom_facilities' then
          (array['Restocked paper towels.',
                 'Plumber snaked the line, draining fine now.',
                 'Cleaned and restocked.',
                 'Adjusted the flush valve.']::text[])[1 + floor(random()*4)::int]
        when mp.category = 'pro_shop' then
          (array['Opened a second register during the rush.',
                 'Ordered more inventory in that size.',
                 'Swapped in a full rental set.',
                 'Refilled the scorecard printer.']::text[])[1 + floor(random()*4)::int]
        when mp.category = 'practice_facility' then
          (array['Replaced the worn mats.',
                 'Aerated and topdressed the practice green.',
                 'Cleared the jam in the ball machine.',
                 'Refilled the range buckets.']::text[])[1 + floor(random()*4)::int]
        when mp.category = 'safety' then
          (array['Moved the cart, reminded staff about parking on slopes.',
                 'Filled and marked the hole near the path.',
                 'Logged the weather call, horn sounded per policy.',
                 'Crew cleared the branch right away.']::text[])[1 + floor(random()*4)::int]
        when mp.category = 'caddie_valet' then
          (array['Spoke with the valet staff about turnaround time.',
                 'Reviewed the yardage book with the caddie.',
                 'Reminder sent to the bag drop team to stay attended.',
                 'Paired promptly going forward.']::text[])[1 + floor(random()*4)::int]
        else
          (array['Reviewed, no specific action needed.',
                 'Followed up with the member, resolved verbally.',
                 'Could not identify a specific issue, closing out.',
                 'Routed to management for awareness.']::text[])[1 + floor(random()*4)::int]
      end
    end as resolution_note,
    case when mp.status not in ('resolved','closed_no_action') then null else
      case
        when mp.category = 'course_maintenance' and mp.location_id in ('a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000012') then
          (array['Thanks for the heads up, our irrigation team repaired the sprinkler and the area is drying out.',
                 'We found and fixed a broken sprinkler line in that area, appreciate the report.',
                 'Our grounds crew adjusted that irrigation zone, should be back to normal soon.']::text[])[1 + floor(random()*3)::int]
        when mp.category = 'course_maintenance' and mp.location_id = 'a0000000-0000-0000-0000-000000000007' then
          (array['Thanks for flagging that, we patched the cart path and it is on our list for a full repair.',
                 'We repaired that section of cart path, should ride smoother now.']::text[])[1 + floor(random()*2)::int]
        when mp.category = 'course_maintenance' then
          (array['Thanks for letting us know, our grounds crew took care of it.',
                 'Appreciate the report, that has been fixed.',
                 'We had the crew address this, thank you for flagging it.',
                 'Good catch, resolved by our maintenance team.']::text[])[1 + floor(random()*4)::int]
        when mp.category = 'pace_of_play' then
          (array['Thanks for the note, we sent a marshal out to help keep things moving.',
                 'Appreciate you letting us know, we spoke with the group ahead.',
                 'We are aware and working on pace today, thank you for your patience.']::text[])[1 + floor(random()*3)::int]
        when mp.category = 'cart_issue' then
          (array['Thanks for reporting that, the cart has been serviced.',
                 'We swapped out the cart, appreciate the heads up.',
                 'Fixed and back in the fleet, thank you.']::text[])[1 + floor(random()*3)::int]
        when mp.category = 'f_and_b' then
          (array['Thanks for letting us know, we have restocked and it is fixed.',
                 'Appreciate the note, that has been taken care of.',
                 'We got that resolved, thanks for flagging it.']::text[])[1 + floor(random()*3)::int]
        when mp.category = 'restroom_facilities' then
          (array['Thanks for letting us know, that has been cleaned and restocked.',
                 'We had that repaired, appreciate the report.']::text[])[1 + floor(random()*2)::int]
        when mp.category = 'pro_shop' then
          (array['Thanks for the feedback, we have addressed that at the shop.',
                 'Appreciate you letting us know, that has been handled.']::text[])[1 + floor(random()*2)::int]
        when mp.category = 'practice_facility' then
          (array['Thanks for the note, we have made improvements to the range.',
                 'That has been addressed, appreciate the report.']::text[])[1 + floor(random()*2)::int]
        when mp.category = 'safety' then
          (array['Thank you for reporting this, we addressed it right away as a safety priority.',
                 'We appreciate you flagging this, it has been resolved.',
                 'Thanks for the safety report, our team responded immediately.']::text[])[1 + floor(random()*3)::int]
        when mp.category = 'caddie_valet' then
          (array['Thanks for the feedback, we have talked with our caddie and valet team.',
                 'Appreciate the note, we are working on faster turnaround.']::text[])[1 + floor(random()*2)::int]
        else
          (array['Thanks for letting us know, we have looked into this.',
                 'Appreciate the note, thank you for reaching out.']::text[])[1 + floor(random()*2)::int]
      end
    end as member_message
  from meta_pick mp
)

select
  gen_random_uuid() as report_id,
  'c0000000-0000-0000-0000-000000000001'::uuid as course_id,
  cp.location_id,
  cp.qr_code_id,
  cp.body,
  cp.ai_summary,
  cp.source,
  case when cp.source = 'staff' then cp.assignee_id else null end as filed_by,
  case when cp.has_reporter_name then cp.reporter_name_pool else null end as reporter_name,
  case when cp.has_phone then '571-555-0' || lpad(floor(random()*900+100)::text, 3, '0') else null end as reporter_phone,
  case when cp.has_member_no then 'BH-' || lpad(floor(random()*4000)::text, 4, '0') else null end as reporter_member_no,
  cp.reporter_language,
  (cp.has_phone and random() < 0.4) as sms_opt_in,
  cp.category,
  cp.urgency,
  cp.ai_confidence,
  jsonb_build_object('model', 'triage-v1', 'category', cp.category, 'confidence', cp.ai_confidence) as ai_raw,
  cp.triage_source,
  cp.department_id,
  cp.status,
  case when cp.status <> 'new' then cp.assignee_id else null end as claimed_by,
  cp.acknowledged_at_pre as claimed_at,
  cp.scheduled_for_pre as scheduled_for,
  cp.escalation_level_pre as escalation_level,
  cp.acknowledged_at_pre as acknowledged_at,
  cp.resolved_at_pre as resolved_at,
  case when cp.status in ('resolved','closed_no_action') then cp.assignee_id else null end as resolved_by,
  cp.resolution_note,
  cp.close_reason_pre as close_reason,
  cp.member_message,
  case when cp.member_message is not null
       then least(cp.resolved_at_pre + ((1 + floor(random()*30))::int || ' minutes')::interval, now() - interval '2 minutes')
       else null end as member_notified_at,
  cp.resolved_on_site_pre as resolved_on_site,
  cp.created_at,
  -- Helper timestamps for the report_events trail below — not reports
  -- columns, just used to keep the event trail internally consistent.
  cp.created_at + (floor(random()*40 + 15) || ' seconds')::interval as triaged_at,
  cp.created_at + (floor(random()*70 + 45) || ' seconds')::interval as routed_at,
  cp.created_at + (floor(random()*100 + 75) || ' seconds')::interval as notified_at
from content_pick cp;

-- ---------------------------------------------------------------------
-- 7. Insert the synthesized reports.
-- ---------------------------------------------------------------------
insert into reports (
  id, course_id, location_id, qr_code_id, body, ai_summary, source, filed_by,
  reporter_name, reporter_phone, reporter_member_no, reporter_language, sms_opt_in,
  category, urgency, ai_confidence, ai_raw, triage_source, department_id,
  status, claimed_by, claimed_at, scheduled_for, escalation_level,
  acknowledged_at, resolved_at, resolved_by, resolution_note, close_reason,
  member_message, member_notified_at, resolved_on_site, created_at
)
select
  report_id, course_id, location_id, qr_code_id, body, ai_summary, source, filed_by,
  reporter_name, reporter_phone, reporter_member_no, reporter_language, sms_opt_in,
  category, urgency, ai_confidence, ai_raw, triage_source, department_id,
  status, claimed_by, claimed_at, scheduled_for, escalation_level,
  acknowledged_at, resolved_at, resolved_by, resolution_note, close_reason,
  member_message, member_notified_at, resolved_on_site, created_at
from seed_reports
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 8. report_events — a consistent trail matching each report's own
--    columns exactly, since every dashboard metric is computed from
--    this table.
-- ---------------------------------------------------------------------
insert into report_events (report_id, course_id, type, actor_id, payload, created_at)
select report_id, course_id, 'created'::report_event_type, filed_by,
       jsonb_build_object('source', source::text, 'location_id', location_id), created_at
from seed_reports
union all
select report_id, course_id, 'triaged'::report_event_type, null,
       jsonb_build_object('category', category, 'urgency', urgency::text, 'confidence', ai_confidence), triaged_at
from seed_reports
union all
select report_id, course_id, 'routed'::report_event_type, null,
       jsonb_build_object('department_id', department_id), routed_at
from seed_reports
union all
select report_id, course_id, 'notified'::report_event_type, null,
       jsonb_build_object('channel', 'push'), notified_at
from seed_reports
union all
select report_id, course_id, 'acknowledged'::report_event_type, claimed_by,
       jsonb_build_object('by', claimed_by), acknowledged_at
from seed_reports
where acknowledged_at is not null
union all
select report_id, course_id, 'scheduled'::report_event_type, claimed_by,
       jsonb_build_object('scheduled_for', scheduled_for), acknowledged_at
from seed_reports
where status = 'scheduled' and scheduled_for is not null
union all
select report_id, course_id, 'resolved'::report_event_type, resolved_by,
       jsonb_build_object('by', resolved_by, 'close_reason', close_reason), resolved_at
from seed_reports
where resolved_at is not null
union all
select report_id, course_id, 'member_notified'::report_event_type, resolved_by,
       jsonb_build_object('channel', 'sms_or_push'), member_notified_at
from seed_reports
where member_notified_at is not null;

-- ---------------------------------------------------------------------
-- 9. triage_queue — every historical report already worked through the
--    queue, so it lands here as 'done'.
-- ---------------------------------------------------------------------
insert into triage_queue (report_id, status, attempts, locked_at, next_attempt_at, last_error, created_at)
select report_id, 'done'::queue_status, 1, notified_at, notified_at, null, created_at
from seed_reports
on conflict (report_id) do nothing;

drop table if exists seed_reports;

commit;
