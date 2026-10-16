-- "Only this product, no substitutes" for a pinned preference.
alter table public.product_preferences add column if not exists strict boolean not null default false;

-- Products sold by weight (butcher, deli, produce). Each chain uses its own internal
-- code for them, so they are carried by few branches and get crowded out of
-- search_products; this searches only weighed items.
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
    and (select bool_and(norm_text(p.name) like '%' || w || '%') from unnest(words) w)
  group by p.barcode, p.name, p.manufacturer, p.quantity, p.unit_of_measure, p.is_weighted
  order by (norm_text(p.name) like norm_text(trim(term)) || '%') desc, length(p.name), min(pr.price)
  limit max_results;
end $$;

grant execute on function public.search_weighed(text, int) to authenticated;
revoke execute on function public.search_weighed(text, int) from anon, public;
