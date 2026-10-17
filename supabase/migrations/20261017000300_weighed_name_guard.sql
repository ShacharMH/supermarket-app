-- Guard against chain-internal barcodes that collide between chains.

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
           coalesce(e->'factors', '{}') as factors,
           array(select he_stem(w) from unnest(regexp_split_to_array(norm_text(trim(e->>'key')), '\s+')) w
                 where length(w) >= 2) as stems
    from jsonb_array_elements(items) e
  ),
  offers as (
    select b.id as branch_id, b.chain_id, it.key, q.qty, pr.barcode, pr.item_name, pr.price,
           c.total, c.promo, c.promo_min_qty,
           coalesce((it.factors->>pr.barcode)::numeric, 1) as factor,
           (cardinality(it.preferred) = 0 or pr.barcode = any(it.preferred)) as is_preferred
    from it
    join prices pr on pr.barcode = any(it.candidates)
    join branches b on b.id = pr.branch_id and b.tracked and in_my_areas(b.id)
    join products p on p.barcode = pr.barcode
    cross join lateral (select coalesce((it.qtys->>pr.barcode)::numeric, it.qty) as qty) q
    cross join lateral item_cost(b.id, b.chain_id, pr.barcode, pr.price, q.qty, clubs) c
    -- weighed goods use chain-internal codes that can collide between chains
    -- (7290000046181 = grapes in one chain, Emek cheese in another): the branch's
    -- own name for the item must mention what was asked for
    where not p.is_weighted
       or exists (select 1 from unnest(it.stems) s where word_match(norm_text(pr.item_name), s))
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
  where b.tracked and in_my_areas(b.id)
  group by b.id, ch.name
$$;

