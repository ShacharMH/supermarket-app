-- search_products scanned every product with a per-row function call (~2-3s,
-- enough to hit the API statement timeout when several items search at once).
-- Index the normalised name with trigrams and filter on the longest word first.

create index if not exists products_norm_name_trgm_idx
  on public.products using gin (public.norm_text(name) extensions.gin_trgm_ops);

create or replace function public.search_products(term text, max_results int default 15)
returns table (
  barcode text, name text, manufacturer text, quantity numeric, unit_of_measure text,
  is_weighted boolean, branches int, min_price numeric, max_price numeric
)
language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  words text[];
  longest text;
begin
  select array_agg(w order by length(w) desc) into words
  from unnest(regexp_split_to_array(norm_text(trim(term)), '\s+')) w where w <> '';
  if words is null then
    return;
  end if;
  longest := words[1];
  return query
  with hits as (
    select p.* from products p
    where norm_text(p.name) like '%' || longest || '%'
      and (select bool_and(norm_text(p.name) like '%' || w || '%') from unnest(words) w)
  )
  select h.barcode, h.name, h.manufacturer, h.quantity, h.unit_of_measure, h.is_weighted,
         count(pr.branch_id)::int, min(pr.price), max(pr.price)
  from hits h
  join prices pr on pr.barcode = h.barcode
  join branches b on b.id = pr.branch_id and b.tracked
  group by h.barcode, h.name, h.manufacturer, h.quantity, h.unit_of_measure, h.is_weighted
  order by (norm_text(h.name) like norm_text(trim(term)) || '%') desc,
           count(pr.branch_id) desc, length(h.name), min(pr.price)
  limit max_results;
end $$;

grant execute on function public.search_products(text, int) to authenticated;
revoke execute on function public.search_products(text, int) from anon, public;
