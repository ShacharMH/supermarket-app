-- Per-candidate quantity and comparison factor.
-- items[].qtys:    {"barcode": packs}  how many of THIS product fill the request
--                  (e.g. 5 litres = 1 x 4L or 5 x 1L); defaults to items[].qty
-- items[].factors: {"barcode": f}      multiplies the cost only when choosing, to
--                  compare similar packs per gram/ml (300g vs 250g); not shown to the user

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
    select b.id as branch_id, it.key, q.qty, pr.barcode, pr.item_name, pr.price,
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
