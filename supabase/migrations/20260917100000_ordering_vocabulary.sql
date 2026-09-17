-- The words the database needs before food can be ordered.
--
-- Separated from the feature migration (20260917110000) for one reason:
-- `alter type ... add value` commits a new enum label, but Postgres refuses to
-- let the SAME transaction use it, and scripts/apply-migrations.mts wraps each
-- file in its own transaction. Adding and using a label in one file therefore
-- fails with "unsafe use of new value of enum type". Two files, applied in
-- order, is the whole reason this one is short.
--
-- Three additions:
--
--   reports.kind        'issue' (something is wrong) or 'order' (a member
--                       wants something brought to them). Text with a check
--                       rather than an enum, so the next kind — a caddie
--                       request, a tee-time change — is a constraint edit and
--                       not this dance again. Everything that exists today is
--                       an issue, which is what the default says.
--
--   triage_source       gains 'declared'. An order is not classified: the
--                       member said what it was by tapping "order food and
--                       drink", and pretending a model or a keyword decided
--                       would corrupt the one number that says how much of
--                       triage the model is actually doing.
--
--   close_reason        gains 'cannot_fulfil'. A kitchen that has run out of
--                       chicken wraps has not received an invalid report or a
--                       duplicate, and marking the order 'resolved' would
--                       count a member who got nothing as a member who was
--                       served.

alter table reports
  add column if not exists kind text not null default 'issue';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reports_kind_check'
  ) then
    alter table reports
      add constraint reports_kind_check check (kind in ('issue', 'order'));
  end if;
end $$;

comment on column reports.kind is
  'issue = something is wrong; order = a member asked for something (food and drink today).';

-- An order is always read, listed and routed by kind somewhere.
create index if not exists reports_kind_idx on reports (course_id, kind);

alter type triage_source add value if not exists 'declared';
alter type close_reason  add value if not exists 'cannot_fulfil';
