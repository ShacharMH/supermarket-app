-- For list terms: how many products sold by weight vs packaged carry that name, so the
-- list editor knows "גאודה עיזים" comes from the deli counter without a built-in list.
create or replace function public.term_kinds(terms text[])
returns table (term text, weighed_start int, packed_start int, weighed_all int, packed_all int)
language sql stable security invoker set search_path = public, extensions as $$
  with t as (
    select x as term, norm_text(trim(x)) as norm,
           array(select he_stem(w) from unnest(regexp_split_to_array(norm_text(trim(x)), '\s+')) w where w <> '') as words
    from unnest(terms) x
    where length(trim(x)) >= 2
  ),
  m as (
    select t.term, p.is_weighted, norm_text(p.name) ~ ('^' || t.words[1]) as starts
    from t
    join products p on norm_text(p.name) like '%' || t.words[1] || '%'
     and (select bool_and(word_match(norm_text(p.name), w)) from unnest(t.words) w)
     and exists (select 1 from prices pr where pr.barcode = p.barcode)
  )
  select t.term,
         count(*) filter (where m.is_weighted and m.starts)::int,
         count(*) filter (where not m.is_weighted and m.starts)::int,
         count(*) filter (where m.is_weighted)::int,
         count(*) filter (where not m.is_weighted)::int
  from t left join m on m.term = t.term
  group by t.term
$$;

grant execute on function public.term_kinds(text[]) to authenticated;
revoke execute on function public.term_kinds(text[]) from anon, public;
