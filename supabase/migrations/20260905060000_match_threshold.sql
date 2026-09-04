-- Restore the confidence floor the TypeScript matcher has always had.
--
-- Without it, a weak single-word rule wins instead of deferring: "the guy in
-- the cart next to us keeps yelling at everyone" matched a bare "cart" at 0.40
-- and was routed to the cart fleet. A wrong keyword match is worse than no
-- match, because no match simply escalates to the model.
create or replace function match_keywords(p_text text)
returns table (category text, urgency report_urgency, confidence numeric, matched text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_norm      text;
  v_idiom     boolean;
  v_threshold constant numeric := 0.6;   -- mirrors ACCEPT_THRESHOLD
begin
  if p_text is null or btrim(p_text) = '' then return; end if;

  v_norm := ' ' || btrim(regexp_replace(
      regexp_replace(lower(p_text), '[^a-z0-9''\s]', ' ', 'g'),
      '\s+', ' ', 'g')) || ' ';

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
       and k.confidence >= v_threshold
       and not exists (
         select 1 from unnest(k.exclude) as ex(p)
          where v_norm like '%' || ' ' || ex.p || ' ' || '%'
       )
       and not (k.category = 'safety' and v_idiom and k.word_count <= 2)
     order by (k.category = 'safety') desc, k.word_count desc, k.confidence desc
     limit 1;
end;
$$;

revoke execute on function match_keywords(text) from public, anon;
grant execute on function match_keywords(text) to authenticated, service_role;
