-- Hebrew-aware matching: final letters (ם/מ, ן/נ ...) are normalised and list words
-- are reduced to a stem, so "מלפפונים" finds "מלפפון" and "עגבניות" finds "עגבניה".

create or replace function public.norm_text(t text)
returns text language sql immutable set search_path = public as $$
  select translate(lower(regexp_replace(coalesce(t, ''), '[''"`׳״]', '', 'g')), 'ךםןףץ', 'כמנפצ')
$$;

-- plural / feminine endings: מלפפונימ -> מלפפונ, עגבניות -> עגבני, עגבנייה -> עגבני
create or replace function public.he_stem(w text)
returns text language sql immutable set search_path = public as $$
  select case when length(w) >= 5 and w ~ '^[א-ת]+$'
              then regexp_replace(regexp_replace(w, '(ימ|ות|יה|ה)$', ''), 'י$', '')
              else w end
$$;

-- the expression indexes depend on norm_text
reindex index public.products_norm_name_trgm_idx;
reindex index public.prices_item_name_trgm_idx;

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
    where norm_text(p.name) like '%' || words[1] || '%'
      and (select bool_and(word_match(norm_text(p.name), w)) from unnest(words) w)
  )
  select h.barcode, h.name, h.manufacturer, h.quantity, h.unit_of_measure, h.is_weighted,
         count(pr.branch_id)::int, min(pr.price), max(pr.price)
  from hits h
  join prices pr on pr.barcode = h.barcode
  join branches b on b.id = pr.branch_id and b.tracked
  group by h.barcode, h.name, h.n, h.manufacturer, h.quantity, h.unit_of_measure, h.is_weighted
  order by (h.n ~ ('^' || words[array_length(words, 1)])) desc,   -- name starts with the term
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
  first_word text;
begin
  select array_agg(he_stem(w) order by length(w) desc) into words
  from unnest(regexp_split_to_array(norm_text(trim(term)), '\s+')) w where w <> '';
  if words is null then
    return;
  end if;
  first_word := he_stem(split_part(norm_text(trim(term)), ' ', 1));
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
  order by (norm_text(p.name) ~ ('^' || first_word)) desc,     -- "עגבניה" before "גאודה עגבניות"
           count(pr.branch_id) desc, length(p.name), min(pr.price)
  limit max_results;
end $$;

-- products the user marked "not this" for a list term (normalised names)
alter table public.term_settings add column if not exists excluded text[] not null default '{}';

grant execute on function public.he_stem(text) to authenticated;
