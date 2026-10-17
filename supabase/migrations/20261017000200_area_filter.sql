-- Only compare branches in the user's current areas. Tracking is updated by the
-- nightly job, so after an area is removed its branches would otherwise keep
-- showing up until the next run.

-- same as norm_city() in ingest/geo.py (the key of city_geo)
create or replace function public.city_key(t text)
returns text language sql immutable set search_path = public as $$
  select replace(trim(regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''),
           '["''`׳״]', '', 'g'), '[-–_/,.()]', ' ', 'g'), '\s+', ' ', 'g')), 'תל אביב יפו', 'תל אביב')
$$;

create or replace function public.in_my_areas(p_branch bigint)
returns boolean
language sql stable security invoker set search_path = public as $$
  with b as (
    select br.is_online, city_key(br.city) as city,
           coalesce(br.lat, g.lat) as lat, coalesce(br.lon, g.lon) as lon
    from branches br left join city_geo g on g.city = city_key(br.city)
    where br.id = p_branch
  )
  select case
    when not exists (select 1 from user_areas) then true   -- no areas yet: show everything tracked
    when (select is_online from b) then true                -- online stores deliver to the area
    else exists (
      select 1 from user_areas a, b
      where (a.city is not null and city_key(a.city) = b.city)
         or (a.lat is not null and b.lat is not null
             and 6371 * 2 * asin(sqrt(power(sin(radians(b.lat - a.lat) / 2), 2)
                 + cos(radians(a.lat)) * cos(radians(b.lat)) * power(sin(radians(b.lon - a.lon) / 2), 2)))
                 <= a.radius_km + 0.5)
    )
  end
$$;

grant execute on function public.in_my_areas(bigint) to authenticated;
revoke execute on function public.in_my_areas(bigint) from anon, public;

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
    join branches b on b.id = pr.branch_id and b.tracked and in_my_areas(b.id)
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
  where b.tracked and in_my_areas(b.id)
  group by b.id, ch.name
$$;

