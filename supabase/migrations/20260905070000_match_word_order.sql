-- Preserve word order when repairing misspellings.
--
-- string_agg over unnest has no guaranteed ordering, so the rebuild scrambled
-- the text: "cart wont start at all on hole 2" became "on hole 2 all at start
-- wont cart". Single-word rules still matched, which made the matcher look
-- healthy while every multi-word phrase — the specific, high-confidence ones
-- that do the real work — silently stopped matching.
--
-- WITH ORDINALITY plus an explicit ORDER BY keeps the sentence a sentence.
create or replace function match_keywords(p_text text)
returns table (category text, urgency report_urgency, confidence numeric, matched text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_norm      text;
  v_idiom     boolean;
  v_threshold constant numeric := 0.6;   -- mirrors ACCEPT_THRESHOLD in TypeScript
begin
  if p_text is null or btrim(p_text) = '' then return; end if;

  v_norm := btrim(regexp_replace(
      regexp_replace(lower(p_text), '[^a-z0-9''\s]', ' ', 'g'),
      '\s+', ' ', 'g'));
  if v_norm = '' then return; end if;

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
       -- when a known idiom is present ("this hole is a killer").
       and not (k.category = 'safety' and v_idiom and k.word_count <= 2)
     order by (k.category = 'safety') desc, k.word_count desc, k.confidence desc
     limit 1;
end;
$$;

revoke execute on function match_keywords(text) from public, anon;
grant execute on function match_keywords(text) to authenticated, service_role;
