-- Distance to stores: street-level store locations and the user's home point, so the
-- nearer of two equally cheap stores comes first.
alter table public.branches add column if not exists geo_exact boolean;
alter table public.branches add column if not exists geo_checked_at timestamptz;

create table if not exists public.user_profile (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  home_lat   double precision,
  home_lon   double precision,
  home_label text,
  updated_at timestamptz not null default now()
);
alter table public.user_profile enable row level security;
create policy "own profile" on public.user_profile for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
