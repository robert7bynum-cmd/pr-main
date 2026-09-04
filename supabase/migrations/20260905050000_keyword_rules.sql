-- The keyword pass, moved into the database.
--
-- It used to live only in TypeScript, which meant running triage anywhere other
-- than the Next app required shipping a 36KB copy of the rules — and a second
-- copy is how the auth stub drifted and broke every test suite. Rules are data;
-- they belong in a table. The matcher is implemented once here, so the edge
-- function and the local test suite exercise exactly the same code.
--
-- It also makes the rules tunable by a manager later, which the plan always
-- called for: the model classifies, but data decides.

create table if not exists triage_keywords (
  id         bigserial primary key,
  phrase     text not null,
  category   text not null,
  urgency    report_urgency not null default 'normal',
  confidence numeric(3,2) not null default 0.8,
  exclude    text[] not null default '{}',
  word_count int generated always as (array_length(string_to_array(btrim(phrase), ' '), 1)) stored,
  unique (phrase, category)
);
create index if not exists triage_keywords_phrase_idx on triage_keywords (phrase);
alter table triage_keywords enable row level security;

-- Readable by staff (so an admin screen can show them later); writable only by
-- the service role.
drop policy if exists staff_read on triage_keywords;
create policy staff_read on triage_keywords for select to authenticated using (true);

-- Misspellings golfers actually type on a phone, one-handed, mid-round.
create table if not exists triage_misspellings (
  wrong text primary key,
  right_word text not null
);
alter table triage_misspellings enable row level security;

-- Idioms that must never trigger a safety alert. "This hole is a killer" is not
-- an emergency, and paging management for one is how staff learn to ignore
-- alerts entirely.
create table if not exists triage_safety_idioms (
  phrase text primary key
);
alter table triage_safety_idioms enable row level security;

/**
 * The matcher. Deterministic, and the only implementation.
 *
 * Selection order:
 *   1. safety outranks everything that survived the idiom guard — the two
 *      errors are not symmetric: a false hazard flag costs a glance, a missed
 *      one costs more
 *   2. more words (more specific) wins
 *   3. higher confidence breaks the tie
 * Returns nothing when no rule is confident, which is the signal to escalate to
 * the model. A wrong guess is worse than deferring.
 */
create or replace function match_keywords(p_text text)
returns table (category text, urgency report_urgency, confidence numeric, matched text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_norm  text;
  v_idiom boolean;
begin
  if p_text is null or btrim(p_text) = '' then return; end if;

  -- Lowercase, strip punctuation, collapse whitespace, pad so every phrase
  -- match is a whole-word match.
  v_norm := ' ' || btrim(regexp_replace(
      regexp_replace(lower(p_text), '[^a-z0-9''\s]', ' ', 'g'),
      '\s+', ' ', 'g')) || ' ';

  -- Repair known misspellings word by word.
  select ' ' || string_agg(coalesce(m.right_word, w.word), ' ') || ' '
    into v_norm
    from unnest(string_to_array(btrim(v_norm), ' ')) as w(word)
    left join triage_misspellings m on m.wrong = w.word;

  select exists (
    select 1 from triage_safety_idioms i where v_norm like '%' || i.phrase || '%'
  ) into v_idiom;

  return query
    select k.category, k.urgency, k.confidence, k.phrase
      from triage_keywords k
     where v_norm like '%' || ' ' || k.phrase || ' ' || '%'
       and not exists (
         select 1 from unnest(k.exclude) as ex(p)
          where v_norm like '%' || ' ' || ex.p || ' ' || '%'
       )
       -- Weak safety rules are suppressed when an idiom is present; specific
       -- multi-word safety phrases always stand.
       and not (k.category = 'safety' and v_idiom and k.word_count <= 2)
     order by (k.category = 'safety') desc, k.word_count desc, k.confidence desc
     limit 1;
end;
$$;

revoke execute on function match_keywords(text) from public, anon;
grant execute on function match_keywords(text) to authenticated, service_role;
