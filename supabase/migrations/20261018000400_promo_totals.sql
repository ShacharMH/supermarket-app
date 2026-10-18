-- Promotion prices are the total for MinQty units ("2 ב-35" = 35 for two; "1.9 ק"ג ב-57"),
-- also when that total is below one unit's list price ("2 ב-7" for a ₪7.50 item).

create or replace function public.item_cost(
  p_branch bigint, p_chain text, p_barcode text, p_price numeric, p_qty numeric, p_clubs text[]
)
returns table (total numeric, promo text, promo_min_qty numeric)
language sql stable security invoker set search_path = public as $$
  with promos as (
    select pm.description, greatest(coalesce(pm.min_qty, 1), 1) as m, pm.max_qty,
           case
             when pm.discounted_price is not null and pm.discounted_price > 0 then
               case when coalesce(pm.min_qty, 1) > 1
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

create or replace function public.promo_hint(
  p_branch bigint, p_chain text, p_barcode text, p_price numeric, p_qty numeric, p_clubs text[]
)
returns table (description text, min_qty numeric, unit_price numeric)
language sql stable security invoker set search_path = public as $$
  with promos as (
    select pm.description, greatest(coalesce(pm.min_qty, 1), 1) as m,
           case
             when pm.discounted_price is not null and pm.discounted_price > 0 then
               case when coalesce(pm.min_qty, 1) > 1
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
