-- One matcher.
--
-- The keyword pass existed twice: a TypeScript `matchKeywords` in
-- lib/triage/keywords.ts, which is what `npm run triage:eval` and
-- `triage:coverage` tested, and this SQL function, which is what production
-- ran. They were written to the same intent and disagreed on 35 of 397 inputs
-- — every one of them the dangerous direction. "my back is killing me, call
-- 911 on 12" was safety/urgent in the suite that was green and null in the
-- database that was live, because:
--
--   * The idiom guard here suppressed safety rules by word count
--     (`word_count <= 2`), so "call 911", "not breathing", "chest pain",
--     "passed out" and "hit by a ball" all vanished the moment a golfer also
--     said "killer hole". The TypeScript — and this function's own header —
--     suppressed by confidence (< 0.8): weak single words like "snake" and
--     "bees" step aside for an idiom; a specific phrase never does.
--   * Normalisation kept apostrophes here and dropped them there, so
--     "cart won't start" matched in the suite and not in production, while
--     every rule phrase was written apostrophe-free on the TypeScript's
--     promise.
--
-- The TypeScript matcher is deleted. Rules stay in lib/triage/keywords.ts as
-- data, lib/triage/load-rules.ts loads them, and the eval suites now boot a
-- throwaway Postgres and call this function — the same one production calls.
-- Where a fixture asserts a behaviour, it is asserting on this.
--
-- Unchanged from the previous definition: the 0.6 confidence floor, exclude
-- handling, safety-first ordering, WITH ORDINALITY word repair.
--
-- Rule: the rule table is data and the matcher is this function. Anything
-- that needs to classify text calls it; nothing reimplements it.

create or replace function match_keywords(p_text text)
returns table (category text, urgency report_urgency, confidence numeric, matched text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_norm      text;
  v_idiom     boolean;
  v_threshold constant numeric := 0.6;   -- below this, defer to the model
begin
  if p_text is null or btrim(p_text) = '' then return; end if;

  -- Lowercase; drop apostrophes and right single quotes outright so "won't"
  -- becomes "wont" (rule phrases are written that way); every other
  -- non-alphanumeric becomes a space; collapse whitespace.
  v_norm := btrim(regexp_replace(
      regexp_replace(
        regexp_replace(lower(p_text), '[''’]', '', 'g'),
        '[^a-z0-9\s]', ' ', 'g'),
      '\s+', ' ', 'g'));
  if v_norm = '' then return; end if;

  -- Repair known misspellings word by word, keeping the sentence a sentence.
  select ' ' || string_agg(coalesce(m.right_word, w.word), ' ' order by w.pos) || ' '
    into v_norm
    from unnest(string_to_array(v_norm, ' ')) with ordinality as w(word, pos)
    left join triage_misspellings m on m.wrong = w.word;

  select exists (
    select 1 from triage_safety_idioms i where v_norm like '%' || i.phrase || '%'
  ) into v_idiom;

  return query
    select k.category, k.urgency, k.confidence, k.phrase
      from triage_keywords k
     where v_norm like '%' || ' ' || k.phrase || ' ' || '%'
       and k.confidence >= v_threshold
       and not exists (
         select 1 from unnest(k.exclude) as ex(p)
          where v_norm like '%' || ' ' || ex.p || ' ' || '%'
       )
       -- Safety outranks everything below, so weak safety rules are suppressed
       -- when a known idiom is present ("this hole is a killer"); specific
       -- safety phrases always stand, however short.
       and not (k.category = 'safety' and v_idiom and k.confidence < 0.8)
     order by (k.category = 'safety') desc, k.word_count desc, k.confidence desc
     limit 1;
end;
$$;

-- The worker's function belongs to the worker (20260905200000). Restated so a
-- reader of this file knows who the caller is meant to be.
revoke execute on function match_keywords(text) from public, anon, authenticated;
grant execute on function match_keywords(text) to service_role;
