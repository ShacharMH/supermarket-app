-- One clear name per product, chosen nightly from what the stores call it.

-- The app's normalisation of product names (normName in basket.ts), for exclusions.
create or replace function public.client_norm(t text)
returns text language sql immutable set search_path = public as $$
  select btrim(regexp_replace(translate(lower(regexp_replace(coalesce(t, ''), '["''`׳״]', '', 'g')), 'ךםןףץ', 'כמנפצ'), '\s+', ' ', 'g'))
$$;

-- Every product's shelf names, scored: used by many chains, the first word most stores
-- agree on ("פסטה" over "איטריות"), with its size, not cut off at 20 characters
-- ("פסטה ברילה פפרדלה 25"), no codes, marketing ("יצרן/מותג:") or hidden marks.
create or replace view public.product_name_candidates as
with cand as (
  select pr.barcode,
         btrim(regexp_replace(regexp_replace(pr.item_name, '[‎‏‪-‮]', '', 'g'), '\s+', ' ', 'g')) as nm,
         count(distinct b.chain_id) as chains
  from prices pr join branches b on b.id = pr.branch_id
  where b.tracked and pr.item_name is not null and btrim(pr.item_name) <> ''
  group by 1, 2
),
voted as (
  select *, count(*) over (partition by barcode, split_part(nm, ' ', 1)) as first_word_votes
  from cand
)
select barcode, nm, chains,
       chains * 3
       + least(first_word_votes, 4)
       + case when nm ~ '\d+(\.\d+)?\s*(גרם|גר|ג''|ג|ק"ג|קג|קילו|מ"ל|מל|ליטר|ל''|יח)' then 2 else 0 end
       + case when char_length(nm) between 21 and 40 then 2 when char_length(nm) > 50 then -2 else 0 end
       - case when char_length(nm) in (19, 20) then 3 else 0 end
       - case when nm ~ '[*#@|:/]' then 3 else 0 end
       - case when nm ~ ' - |מחיר מפוקח|יצרן' then 2 else 0 end
       - case when nm ~ '^[A-Za-z0-9]' then 1 else 0 end as score
from voted;

-- Gives each product its best shelf name; exclusions ("not this") follow the rename.
create or replace function public.choose_product_names()
returns int
language plpgsql volatile security invoker set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    with best as (
      select distinct on (barcode) barcode, nm
      from product_name_candidates
      order by barcode, score desc, char_length(nm) desc, nm
    )
    update products p set name = b.nm
      from best b, products o
     where b.barcode = p.barcode and o.barcode = p.barcode and p.name is distinct from b.nm
    returning o.name as old_name, b.nm as new_name
  loop
    n := n + 1;
    if client_norm(r.old_name) <> client_norm(r.new_name) then
      update term_settings
         set excluded = array_replace(excluded, client_norm(r.old_name), client_norm(r.new_name))
       where client_norm(r.old_name) = any(excluded);
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.choose_product_names() from anon, authenticated, public;
