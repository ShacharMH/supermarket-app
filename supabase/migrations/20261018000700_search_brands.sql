-- Search by what the shelves and the maker field say, not only the catalogue's one
-- (often cut-off) name: "ספגטי מוליסנה" finds "פסטה איטלקית ספגטי ל" by La Molisana.
alter table public.products add column if not exists search_text text;
create index if not exists products_search_text_trgm_idx
  on public.products using gin (search_text extensions.gin_trgm_ops);

-- Rebuilt after each nightly load: catalogue name + maker + every shelf name.
create or replace function public.refresh_search_text()
returns int
language sql volatile security invoker set search_path = public as $$
  with names as (
    select barcode, string_agg(distinct item_name, ' ') as shelf from prices group by barcode
  ),
  upd as (
    update products p set search_text = x.t
      from (select p2.barcode, norm_text(concat_ws(' ', p2.name, p2.manufacturer, n.shelf)) as t
              from products p2 left join names n on n.barcode = p2.barcode) x
     where x.barcode = p.barcode and p.search_text is distinct from x.t
    returning 1
  )
  select count(*)::int from upd
$$;
revoke execute on function public.refresh_search_text() from anon, authenticated, public;

create or replace function public.search_products(term text, max_results int default 15)
returns table (
  barcode text, name text, manufacturer text, quantity numeric, unit_of_measure text,
  is_weighted boolean, branches int, min_price numeric, max_price numeric
)
language plpgsql stable security invoker set search_path = public, extensions as $$
declare
  words text[];
begin
  select array_agg(he_stem(w) order by length(w) desc) into words
  from unnest(regexp_split_to_array(norm_text(trim(term)), '\s+')) w where w <> '';
  if words is null then
    return;
  end if;
  return query
  with hits as (
    select p.*, norm_text(p.name) as n from products p
    -- (products added since the last refresh have no search text yet: their name then)
    where (p.search_text like '%' || words[1] || '%'
           or (p.search_text is null and norm_text(p.name) like '%' || words[1] || '%'))
      and (select bool_and(word_match(coalesce(p.search_text, norm_text(p.name)), w)) from unnest(words) w)
  )
  select h.barcode, h.name, h.manufacturer, h.quantity, h.unit_of_measure, h.is_weighted,
         count(pr.branch_id)::int, min(pr.price), max(pr.price)
  from hits h
  join prices pr on pr.barcode = h.barcode
  join branches b on b.id = pr.branch_id and b.tracked
  group by h.barcode, h.name, h.n, h.manufacturer, h.quantity, h.unit_of_measure, h.is_weighted
  order by (select bool_and(word_match(h.n, w)) from unnest(words) w) desc,  -- the name itself says it
           (h.n ~ ('^' || words[array_length(words, 1)])) desc,             -- name starts with the term
           count(pr.branch_id) desc, length(h.name), min(pr.price)
  limit max_results;
end $$;

-- the brands that are fine for a list term ("only these brands"); `brand` was a
-- single-brand first try, left unused
alter table public.term_settings add column if not exists brand text;
alter table public.term_settings add column if not exists brands text[] not null default '{}';
