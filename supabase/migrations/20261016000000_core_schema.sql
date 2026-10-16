-- Core schema: price-transparency data (public, read-only to clients)
-- plus personal data (owner-only). Ingestion writes with the service role,
-- which bypasses RLS.

-- The original empty prototype tables were renamed to legacy_* (RLS on, no policies).

-- ---------- Public price data ----------

create table public.chains (
  chain_id   text primary key,          -- official chain code (e.g. 7290027600007 = Shufersal)
  name       text not null,
  updated_at timestamptz not null default now()
);

create table public.branches (
  id           bigserial primary key,
  chain_id     text not null references public.chains(chain_id) on delete cascade,
  sub_chain_id text,
  store_id     text not null,
  name         text,
  address      text,
  city         text,
  zip_code     text,
  lat          double precision,
  lon          double precision,
  is_online    boolean not null default false,
  tracked      boolean not null default false, -- prices are ingested only for tracked branches
  updated_at   timestamptz not null default now(),
  unique (chain_id, store_id)
);
create index branches_city_idx on public.branches (city);
create index branches_tracked_idx on public.branches (tracked) where tracked;

create table public.products (
  barcode         text primary key,
  name            text not null,
  manufacturer    text,
  quantity        numeric,                -- e.g. 250
  unit_of_measure text,                   -- e.g. גרם
  is_weighted     boolean not null default false,
  updated_at      timestamptz not null default now()
);
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create index products_name_trgm_idx on public.products using gin (name extensions.gin_trgm_ops);

-- Only the latest price per branch+product is kept.
create table public.prices (
  branch_id  bigint not null references public.branches(id) on delete cascade,
  barcode    text not null references public.products(barcode) on delete cascade,
  price      numeric(10,2) not null,
  unit_price numeric(10,2),
  item_name  text,                        -- the chain's own name (what prints on the receipt)
  updated_at timestamptz not null default now(),
  primary key (branch_id, barcode)
);
create index prices_barcode_idx on public.prices (barcode);

create table public.promotions (
  id               bigserial primary key,
  branch_id        bigint not null references public.branches(id) on delete cascade,
  promotion_id     text not null,
  description      text,
  starts_at        timestamptz,
  ends_at          timestamptz,
  min_qty          numeric,               -- e.g. 2 for "2 ב-10"
  max_qty          numeric,
  discounted_price numeric(10,2),         -- total price for min_qty units
  discount_rate    numeric,               -- percent off, when given that way
  reward_type      int,
  club_ids         text[] not null default '{}', -- empty / {'0'} = everyone
  is_club_only     boolean not null default false,
  updated_at       timestamptz not null default now(),
  unique (branch_id, promotion_id)
);

create table public.promotion_items (
  promotion_pk bigint not null references public.promotions(id) on delete cascade,
  barcode      text not null,
  primary key (promotion_pk, barcode)
);
create index promotion_items_barcode_idx on public.promotion_items (barcode);

-- ---------- Personal data (owner-only) ----------

create table public.user_areas (
  id        bigserial primary key,
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  label     text not null,                -- "רמלה", "בית", ...
  city      text,                         -- match by branch city, or
  lat       double precision,             -- center + radius
  lon       double precision,
  radius_km numeric not null default 5,
  created_at timestamptz not null default now()
);

create table public.user_clubs (
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  chain_id text not null references public.chains(chain_id) on delete cascade,
  primary key (user_id, chain_id)
);

-- What the user means by a generic term ("קוטג'") — learned from receipts.
create table public.product_preferences (
  id         bigserial primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  term       text not null,
  barcode    text not null,
  times_bought int not null default 1,
  last_bought  date,
  unique (user_id, term, barcode)
);

create table public.receipts (
  id          bigserial primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  branch_id   bigint references public.branches(id) on delete set null,
  purchased_at date,
  total       numeric(10,2),
  source      text,                       -- 'csv', 'ocr', ...
  created_at  timestamptz not null default now()
);

create table public.receipt_items (
  id         bigserial primary key,
  receipt_id bigint not null references public.receipts(id) on delete cascade,
  raw_name   text not null,
  barcode    text,                        -- resolved barcode (may be null until matched)
  quantity   numeric not null default 1,
  price      numeric(10,2)
);

create table public.shopping_lists (
  id         bigserial primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null default 'הרשימה שלי',
  items      jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

-- ---------- RLS ----------

alter table public.chains            enable row level security;
alter table public.branches          enable row level security;
alter table public.products          enable row level security;
alter table public.prices            enable row level security;
alter table public.promotions        enable row level security;
alter table public.promotion_items   enable row level security;
alter table public.user_areas        enable row level security;
alter table public.user_clubs        enable row level security;
alter table public.product_preferences enable row level security;
alter table public.receipts          enable row level security;
alter table public.receipt_items     enable row level security;
alter table public.shopping_lists    enable row level security;

-- Price data is public information: read-only for signed-in users, no client writes.
create policy "read chains"          on public.chains          for select to authenticated using (true);
create policy "read branches"        on public.branches        for select to authenticated using (true);
create policy "read products"        on public.products        for select to authenticated using (true);
create policy "read prices"          on public.prices          for select to authenticated using (true);
create policy "read promotions"      on public.promotions      for select to authenticated using (true);
create policy "read promotion_items" on public.promotion_items for select to authenticated using (true);

-- Personal tables: owner only.
create policy "own areas"  on public.user_areas for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own clubs"  on public.user_clubs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own prefs"  on public.product_preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own receipts" on public.receipts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own receipt items" on public.receipt_items for all to authenticated
  using (exists (select 1 from public.receipts r where r.id = receipt_id and r.user_id = (select auth.uid())))
  with check (exists (select 1 from public.receipts r where r.id = receipt_id and r.user_id = (select auth.uid())));
create policy "own lists" on public.shopping_lists for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Indexes for FK / policy columns
create index user_areas_user_idx on public.user_areas (user_id);
create index product_preferences_user_idx on public.product_preferences (user_id);
create index receipts_user_idx on public.receipts (user_id);
create index receipts_branch_idx on public.receipts (branch_id);
create index receipt_items_receipt_idx on public.receipt_items (receipt_id);
create index shopping_lists_user_idx on public.shopping_lists (user_id);
create index user_clubs_chain_idx on public.user_clubs (chain_id);
create index branches_chain_idx on public.branches (chain_id);
create index promotions_branch_idx on public.promotions (branch_id);
