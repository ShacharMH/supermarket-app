-- Match list words only at the start of a word in the product name (not in the
-- middle of one), and rank names where every word is a whole word first, so
-- "חלב" puts "חלב 3%" ahead of "חלבה" and "חלבון".

create or replace function public.word_match(name_norm text, w text, whole boolean default false)
returns boolean language sql immutable set search_path = public as $$
  select name_norm ~ ('(^|[^[:alnum:]])' || regexp_replace(w, '([.*+?^${}()|\[\]\\])', '\\\1', 'g')
                      || case when whole then '($|[^[:alnum:]])' else '' end)
$$;

create or replace function public.search_products(term text, max_results int default 15)
returns table (
  barcode text, name text, manufacturer text, quantity numeric, unit_of_measure text,
  is_weighted boolean, branches int, min_price numeric, max_price numeric
)
language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  words text[];
begin
  select array_agg(w order by length(w) desc) into words
  from unnest(regexp_split_to_array(norm_text(trim(term)), '\s+')) w where w <> '';
  if words is null then
    return;
  end if;
  return query
  with hits as (
    select p.*, norm_text(p.name) as n from products p
    where norm_text(p.name) like '%' || words[1] || '%'           -- trigram index
      and (select bool_and(word_match(norm_text(p.name), w)) from unnest(words) w)
  )
  select h.barcode, h.name, h.manufacturer, h.quantity, h.unit_of_measure, h.is_weighted,
         count(pr.branch_id)::int, min(pr.price), max(pr.price)
  from hits h
  join prices pr on pr.barcode = h.barcode
  join branches b on b.id = pr.branch_id and b.tracked
  group by h.barcode, h.name, h.n, h.manufacturer, h.quantity, h.unit_of_measure, h.is_weighted
  order by (select bool_and(word_match(h.n, w, true)) from unnest(words) w) desc,
           (h.n like norm_text(trim(term)) || '%') desc,
           count(pr.branch_id) desc, length(h.name), min(pr.price)
  limit max_results;
end $$;

create or replace function public.search_weighed(term text, max_results int default 40)
returns table (
  barcode text, name text, manufacturer text, quantity numeric, unit_of_measure text,
  is_weighted boolean, branches int, min_price numeric, max_price numeric
)
language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  words text[];
begin
  select array_agg(w order by length(w) desc) into words
  from unnest(regexp_split_to_array(norm_text(trim(term)), '\s+')) w where w <> '';
  if words is null then
    return;
  end if;
  return query
  select p.barcode, p.name, p.manufacturer, p.quantity, p.unit_of_measure, p.is_weighted,
         count(pr.branch_id)::int, min(pr.price), max(pr.price)
  from products p
  join prices pr on pr.barcode = p.barcode
  join branches b on b.id = pr.branch_id and b.tracked
  where p.is_weighted
    and norm_text(p.name) like '%' || words[1] || '%'
    and (select bool_and(word_match(norm_text(p.name), w)) from unnest(words) w)
  group by p.barcode, p.name, p.manufacturer, p.quantity, p.unit_of_measure, p.is_weighted
  order by (select bool_and(word_match(norm_text(p.name), w, true)) from unnest(words) w) desc,
           (norm_text(p.name) like norm_text(trim(term)) || '%') desc, length(p.name), min(pr.price)
  limit max_results;
end $$;

grant execute on function public.search_products(text, int) to authenticated;
grant execute on function public.search_weighed(text, int) to authenticated;
