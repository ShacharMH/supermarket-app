-- "Almost a deal": a promotion the line does not reach yet (buying 1 when it is
-- "2 ב-10"). Returned per chosen line so the app can suggest buying more.

create or replace function public.promo_hint(
  p_branch bigint, p_chain text, p_barcode text, p_price numeric, p_qty numeric, p_clubs text[]
)
returns table (description text, min_qty numeric, unit_price numeric)
language sql stable security invoker set search_path = public as $$
  with promos as (
    select pm.description, greatest(coalesce(pm.min_qty, 1), 1) as m,
           case
             when pm.discounted_price is not null and pm.discounted_price > 0 then
               case when pm.discounted_price >= p_price and coalesce(pm.min_qty, 1) > 1
                    then pm.discounted_price / pm.min_qty
                    else pm.discounted_price end
             when pm.discount_rate is not null and pm.discount_rate > 0 and pm.discount_rate < 100
               then p_price * (1 - pm.discount_rate / 100)
           end as unit_promo
    from promotion_items pi
    join promotions pm on pm.id = pi.promotion_pk
    where pi.barcode = p_barcode and pm.branch_id = p_branch
      and (pm.starts_at is null or pm.starts_at <= now())
      and (pm.ends_at is null or pm.ends_at >= now())
      and (not pm.is_club_only or p_chain = any(p_clubs))
  )
  select description, m, round(unit_promo, 2)
  from promos
  where unit_promo is not null and unit_promo < p_price * 0.97 and unit_promo > p_price * 0.2
    and m > p_qty and m <= p_qty + 5            -- a few more units, not a case of 24
    and p_qty = floor(p_qty)                     -- counted items only, not kilograms
  order by unit_promo
  limit 1
$$;

create or replace function public.price_basket(items jsonb, penalty numeric default 0.15, clubs text[] default '{}')
returns table (
  branch_id bigint, chain_id text, chain_name text, branch_name text, city text, address text,
  is_online boolean, lat double precision, lon double precision, lines jsonb
)
language sql stable security invoker set search_path = public as $$
  with it as (
    select e->>'key' as key, coalesce((e->>'qty')::numeric, 1) as qty,
           array(select jsonb_array_elements_text(e->'candidates')) as candidates,
           array(select jsonb_array_elements_text(coalesce(e->'preferred', '[]'))) as preferred,
           coalesce(e->'qtys', '{}') as qtys,
           coalesce(e->'factors', '{}') as factors
    from jsonb_array_elements(items) e
  ),
  offers as (
    select b.id as branch_id, b.chain_id, it.key, q.qty, pr.barcode, pr.item_name, pr.price,
           c.total, c.promo, c.promo_min_qty,
           coalesce((it.factors->>pr.barcode)::numeric, 1) as factor,
           (cardinality(it.preferred) = 0 or pr.barcode = any(it.preferred)) as is_preferred
    from it
    join prices pr on pr.barcode = any(it.candidates)
    join branches b on b.id = pr.branch_id and b.tracked
    cross join lateral (select coalesce((it.qtys->>pr.barcode)::numeric, it.qty) as qty) q
    cross join lateral item_cost(b.id, b.chain_id, pr.barcode, pr.price, q.qty, clubs) c
  ),
  best as (
    select distinct on (branch_id, key) *
    from offers
    order by branch_id, key, total * factor * (case when is_preferred then 1 else 1 + penalty end), total
  ),
  hinted as (
    select best.*, h.description as hint, h.min_qty as hint_qty, h.unit_price as hint_unit
    from best
    left join lateral promo_hint(best.branch_id, best.chain_id, best.barcode, best.price, best.qty, clubs) h
      on best.promo is null
  )
  select b.id, b.chain_id, ch.name, b.name, b.city, b.address, b.is_online, b.lat, b.lon,
         coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'key', hinted.key, 'qty', hinted.qty, 'barcode', hinted.barcode, 'name', hinted.item_name,
           'price', hinted.price, 'total', hinted.total, 'promo', hinted.promo,
           'promo_min_qty', hinted.promo_min_qty, 'preferred', hinted.is_preferred,
           'hint', hinted.hint, 'hint_qty', hinted.hint_qty, 'hint_unit', hinted.hint_unit
         ))) filter (where hinted.key is not null), '[]'::jsonb)
  from branches b
  join chains ch on ch.chain_id = b.chain_id
  left join hinted on hinted.branch_id = b.id
  where b.tracked
  group by b.id, ch.name
$$;

grant execute on function public.promo_hint(bigint, text, text, numeric, numeric, text[]) to authenticated;
revoke execute on function public.promo_hint(bigint, text, text, numeric, numeric, text[]) from anon, public;
