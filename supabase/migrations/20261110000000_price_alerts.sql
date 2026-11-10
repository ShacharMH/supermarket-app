-- Price-drop alerts on the products the user likes: starred on a receipt, picked in the
-- item sheet, or bought on two receipts or more. Every night the lowest price of each
-- such product in the user's shopping area is kept, and a price well below the usual
-- one becomes an alert (shown in the app, and sent as a push notification).

alter table public.user_profile add column if not exists alerts_on boolean not null default true;
alter table public.user_profile add column if not exists alert_pct numeric not null default 15;       -- % below usual
alter table public.user_profile add column if not exists alert_min_saving numeric not null default 3; -- ₪ per unit
alter table public.user_profile add column if not exists alert_muted text[] not null default '{}';    -- barcodes

-- the lowest price a day, per user and product: what "usual" is measured from
create table if not exists public.watch_prices (
  user_id   uuid not null references auth.users(id) on delete cascade,
  barcode   text not null,
  day       date not null,
  unit_price numeric not null,
  branch_id bigint references public.branches(id) on delete set null,
  promo     text,
  primary key (user_id, barcode, day)
);
alter table public.watch_prices enable row level security;
create policy "own watch prices" on public.watch_prices for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.watch_prices to authenticated;
grant select, insert, update, delete on public.watch_prices to service_role;

create table if not exists public.price_alerts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  barcode     text not null,
  name        text not null,
  branch_id   bigint references public.branches(id) on delete set null,
  unit_price  numeric not null,
  usual_price numeric not null,
  promo       text,
  min_qty     numeric,
  ends_at     timestamptz,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  dismissed   boolean not null default false
);
create index if not exists price_alerts_user on public.price_alerts (user_id, created_at desc);
alter table public.price_alerts enable row level security;
create policy "own alerts" on public.price_alerts for select to authenticated
  using (user_id = (select auth.uid()));
create policy "dismiss own alerts" on public.price_alerts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, update (dismissed) on public.price_alerts to authenticated;
grant select, insert, update, delete on public.price_alerts to service_role;

-- where to send push notifications (one row per browser / phone)
create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy "own subscriptions" on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, insert, update, delete on public.push_subscriptions to service_role;

-- the products each user likes
create or replace view public.watched_products with (security_invoker = true) as
  select w.user_id, w.barcode, bool_or(w.starred) as starred, max(w.receipts) as receipts
  from (
    select r.user_id, ri.barcode, bool_or(ri.reason = 'preferred') as starred, count(distinct r.id) as receipts
    from receipt_items ri join receipts r on r.id = ri.receipt_id
    where ri.barcode is not null
    group by r.user_id, ri.barcode
    union all
    select user_id, barcode, true, 0 from product_preferences
  ) w
  group by w.user_id, w.barcode
  having bool_or(w.starred) or max(w.receipts) >= 2;
grant select on public.watched_products to authenticated, service_role;

-- a branch is in an area: its town, or within the radius (as in_my_areas, for any user)
create or replace function public.branch_in_area(p_branch bigint, p_area bigint)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1 from branches br
    left join city_geo g on g.city = city_key(br.city)
    join user_areas a on a.id = p_area
    where br.id = p_branch and (
      (a.city is not null and city_key(a.city) = city_key(br.city))
      or (a.lat is not null and coalesce(br.lat, g.lat) is not null
          and 6371 * 2 * asin(sqrt(power(sin(radians(coalesce(br.lat, g.lat) - a.lat) / 2), 2)
              + cos(radians(a.lat)) * cos(radians(coalesce(br.lat, g.lat)))
                * power(sin(radians(coalesce(br.lon, g.lon) - a.lon) / 2), 2))) <= a.radius_km + 0.5)
    )
  )
$$;

-- the area the user shops in: the one nearest the saved location, else all their areas
create or replace function public.shopping_areas(p_user uuid)
returns setof bigint language sql stable set search_path = public as $$
  with home as (select home_lat, home_lon from user_profile where user_id = p_user and home_lat is not null),
  nearest as (
    select a.id from user_areas a, home h
    where a.user_id = p_user and a.lat is not null
    order by power(a.lat - h.home_lat, 2) + power((a.lon - h.home_lon) * cos(radians(h.home_lat)), 2)
    limit 1
  )
  select id from nearest
  union all
  select id from user_areas where user_id = p_user and not exists (select 1 from nearest)
$$;

-- tonight's lowest price per watched product, and the alerts it makes; run after the load
create or replace function public.compute_price_alerts()
returns int language plpgsql set search_path = public as $$
declare
  n int;
begin
  with users as (
    select p.user_id, p.alert_pct, p.alert_min_saving, p.alert_muted,
           coalesce((select array_agg(chain_id) from user_clubs c where c.user_id = p.user_id), '{}') as clubs
    from user_profile p where p.alerts_on
  ),
  shops as (
    select distinct u.user_id, b.id as branch_id, b.chain_id
    from users u
    cross join lateral shopping_areas(u.user_id) a(id)
    join branches b on b.tracked and not b.is_online and branch_in_area(b.id, a.id)
    where has_fresh_prices(b.id)
  ),
  offers as (
    -- the shelf price, or a promotion (per unit, at most 6 to buy) if it is lower
    select s.user_id, pr.barcode, s.branch_id, pr.price as unit_price, null::text as promo,
           null::numeric as min_qty, null::timestamptz as ends_at
    from shops s
    join watched_products w on w.user_id = s.user_id
    join users u on u.user_id = s.user_id
    join prices pr on pr.branch_id = s.branch_id and pr.barcode = w.barcode
    where not (w.barcode = any(u.alert_muted))
    union all
    select s.user_id, pr.barcode, s.branch_id,
           round(case when coalesce(pm.discounted_price, 0) > 0
                      then pm.discounted_price / greatest(coalesce(pm.min_qty, 1), 1)
                      else pr.price * (1 - pm.discount_rate / 100) end, 2),
           pm.description, greatest(coalesce(pm.min_qty, 1), 1), pm.ends_at
    from shops s
    join watched_products w on w.user_id = s.user_id
    join users u on u.user_id = s.user_id
    join prices pr on pr.branch_id = s.branch_id and pr.barcode = w.barcode
    join promotion_items pi on pi.barcode = pr.barcode
    join promotions pm on pm.id = pi.promotion_pk and pm.branch_id = s.branch_id
    where not (w.barcode = any(u.alert_muted))
      and (pm.starts_at is null or pm.starts_at <= now())
      and (pm.ends_at is null or pm.ends_at >= now())
      and (not pm.is_club_only or s.chain_id = any(u.clubs))
      and coalesce(pm.min_qty, 1) <= 6
      and (coalesce(pm.discounted_price, 0) > 0 or pm.discount_rate between 0.01 and 99.99)
  ),
  best as (
    select distinct on (user_id, barcode) *
    from offers
    where unit_price > 0
    order by user_id, barcode, unit_price, min_qty nulls first
  ),
  kept as (
    insert into watch_prices (user_id, barcode, day, unit_price, branch_id, promo)
    select user_id, barcode, current_date, unit_price, branch_id, promo from best
    on conflict (user_id, barcode, day) do update
      set unit_price = excluded.unit_price, branch_id = excluded.branch_id, promo = excluded.promo
    returning 1
  ),
  usual as (
    -- the median of the last 30 days; with under a week of history, what was paid on receipts
    select b.*, coalesce(
      (select percentile_cont(0.5) within group (order by h.unit_price)
         from watch_prices h
        where h.user_id = b.user_id and h.barcode = b.barcode
          and h.day between current_date - 30 and current_date - 1
       having count(*) >= 7),
      (select percentile_cont(0.5) within group (order by (ri.price - coalesce(ri.discount, 0)) / ri.quantity)
         from receipt_items ri join receipts r on r.id = ri.receipt_id
        where r.user_id = b.user_id and ri.barcode = b.barcode and ri.quantity > 0 and ri.price > 0)
    )::numeric as usual_price
    from best b
  ),
  fresh as (
    insert into price_alerts (user_id, barcode, name, branch_id, unit_price, usual_price, promo, min_qty, ends_at)
    select u.user_id, u.barcode, coalesce(p.name, u.barcode), u.branch_id, u.unit_price, round(u.usual_price, 2),
           u.promo, u.min_qty, u.ends_at
    from usual u
    join users s on s.user_id = u.user_id
    left join products p on p.barcode = u.barcode
    where u.usual_price is not null
      and u.unit_price <= u.usual_price * (1 - s.alert_pct / 100)
      and u.usual_price - u.unit_price >= s.alert_min_saving
      -- the same deal is told once: not again within two weeks unless it got cheaper still
      and not exists (
        select 1 from price_alerts a
        where a.user_id = u.user_id and a.barcode = u.barcode
          and a.created_at > now() - interval '14 days' and a.unit_price <= u.unit_price + 0.01
      )
    returning 1
  )
  select (select count(*) from fresh) into n;
  return n;
end $$;
revoke execute on function public.compute_price_alerts() from public, anon, authenticated;
revoke execute on function public.shopping_areas(uuid) from public, anon, authenticated;
revoke execute on function public.branch_in_area(bigint, bigint) from public, anon, authenticated;
