-- Search + basket pricing functions called by the app (security invoker -> RLS applies).

create or replace function public.norm_text(t text)
returns text language sql immutable set search_path = public as $$
  select lower(regexp_replace(coalesce(t, ''), '[''"`׳״]', '', 'g'))
$$;

-- Products matching a free-text term, most widely available first.
create or replace function public.search_products(term text, max_results int default 15)
returns table (
  barcode text, name text, manufacturer text, quantity numeric, unit_of_measure text,
  is_weighted boolean, branches int, min_price numeric, max_price numeric
)
language sql stable security invoker set search_path = public as $$
  with words as (
    select w from unnest(regexp_split_to_array(norm_text(trim(term)), '\s+')) w where w <> ''
  ),
  hits as (
    select p.* from products p
    where (select bool_and(norm_text(p.name) like '%' || w || '%') from words)
  )
  select h.barcode, h.name, h.manufacturer, h.quantity, h.unit_of_measure, h.is_weighted,
         count(pr.branch_id)::int, min(pr.price), max(pr.price)
  from hits h
  join prices pr on pr.barcode = h.barcode
  join branches b on b.id = pr.branch_id and b.tracked
  group by h.barcode, h.name, h.manufacturer, h.quantity, h.unit_of_measure, h.is_weighted
  order by (norm_text(h.name) like norm_text(trim(term)) || '%') desc,
           count(pr.branch_id) desc, length(h.name), min(pr.price)
  limit max_results
$$;

-- Effective cost of buying `qty` units of `barcode` at `branch`, applying the best
-- active promotion the user is eligible for.
create or replace function public.item_cost(
  p_branch bigint, p_chain text, p_barcode text, p_price numeric, p_qty numeric, p_clubs text[]
)
returns table (total numeric, promo text, promo_min_qty numeric)
language sql stable security invoker set search_path = public as $$
  with promos as (
    select pm.description, greatest(coalesce(pm.min_qty, 1), 1) as m, pm.max_qty,
           case
             when pm.discounted_price is not null and pm.discounted_price > 0 then
               case when pm.discounted_price >= p_price and coalesce(pm.min_qty, 1) > 1
                    then pm.discounted_price / pm.min_qty     -- "2 ב-10": total for m units
                    else pm.discounted_price end              -- already a unit price
             when pm.discount_rate is not null and pm.discount_rate > 0 and pm.discount_rate < 100
               then p_price * (1 - pm.discount_rate / 100)
           end as unit_promo
    from promotion_items pi
    join promotions pm on pm.id = pi.promotion_pk
    where pi.barcode = p_barcode and pm.branch_id = p_branch
      and (pm.starts_at is null or pm.starts_at <= now())
      and (pm.ends_at is null or pm.ends_at >= now())
      and (not pm.is_club_only or p_chain = any(p_clubs))
  ),
  options as (
    select description, m,
      case when p_qty >= m then
        -- units bought in promo bundles (respecting max_qty), the rest at list price
        (least(floor(p_qty / m) * m, coalesce(max_qty, p_qty))) * unit_promo
        + (p_qty - least(floor(p_qty / m) * m, coalesce(max_qty, p_qty))) * p_price
      end as cost
    from promos where unit_promo is not null and unit_promo < p_price and unit_promo > p_price * 0.2
  )
  select * from (
    select round(cost, 2), description, m from options where cost is not null
    union all
    select round(p_price * p_qty, 2), null, null
  ) x order by 1 limit 1
$$;

-- Prices a shopping list in every tracked branch.
-- items: [{"key": "קוטג", "qty": 2, "candidates": ["729..", ...], "preferred": ["729.."]}]
-- penalty: fraction added to non-preferred candidates when choosing (e.g. 0.15).
-- Returns one row per branch with a jsonb array of the chosen line per item.
create or replace function public.price_basket(items jsonb, penalty numeric default 0.15, clubs text[] default '{}')
returns table (
  branch_id bigint, chain_id text, chain_name text, branch_name text, city text, address text,
  is_online boolean, lat double precision, lon double precision, lines jsonb
)
language sql stable security invoker set search_path = public as $$
  with it as (
    select e->>'key' as key, coalesce((e->>'qty')::numeric, 1) as qty,
           array(select jsonb_array_elements_text(e->'candidates')) as candidates,
           array(select jsonb_array_elements_text(coalesce(e->'preferred', '[]'))) as preferred
    from jsonb_array_elements(items) e
  ),
  offers as (
    select b.id as branch_id, it.key, it.qty, pr.barcode, pr.item_name, pr.price,
           c.total, c.promo, c.promo_min_qty,
           (cardinality(it.preferred) = 0 or pr.barcode = any(it.preferred)) as is_preferred
    from it
    join prices pr on pr.barcode = any(it.candidates)
    join branches b on b.id = pr.branch_id and b.tracked
    cross join lateral item_cost(b.id, b.chain_id, pr.barcode, pr.price, it.qty, clubs) c
  ),
  best as (
    select distinct on (branch_id, key) *
    from offers
    order by branch_id, key, total * (case when is_preferred then 1 else 1 + penalty end), total
  )
  select b.id, b.chain_id, ch.name, b.name, b.city, b.address, b.is_online, b.lat, b.lon,
         coalesce(jsonb_agg(jsonb_build_object(
           'key', best.key, 'qty', best.qty, 'barcode', best.barcode, 'name', best.item_name,
           'price', best.price, 'total', best.total, 'promo', best.promo,
           'promo_min_qty', best.promo_min_qty, 'preferred', best.is_preferred
         )) filter (where best.key is not null), '[]'::jsonb)
  from branches b
  join chains ch on ch.chain_id = b.chain_id
  left join best on best.branch_id = b.id
  where b.tracked
  group by b.id, ch.name
$$;

grant execute on function public.search_products(text, int) to authenticated;
grant execute on function public.price_basket(jsonb, numeric, text[]) to authenticated;
grant execute on function public.item_cost(bigint, text, text, numeric, numeric, text[]) to authenticated;
revoke execute on function public.search_products(text, int) from anon, public;
revoke execute on function public.price_basket(jsonb, numeric, text[]) from anon, public;
revoke execute on function public.item_cost(bigint, text, text, numeric, numeric, text[]) from anon, public;
