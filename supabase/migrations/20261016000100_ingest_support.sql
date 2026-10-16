-- Support tables for the nightly ingestion job.

alter table public.chains add column if not exists scraper text;

create table if not exists public.city_geo (
  city text primary key,          -- normalised city name
  lat  double precision,
  lon  double precision
);

create table if not exists public.ingest_runs (
  id          bigserial primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running',
  note        text
);

alter table public.city_geo    enable row level security;
alter table public.ingest_runs enable row level security;
create policy "read city_geo"    on public.city_geo    for select to authenticated using (true);
create policy "read ingest_runs" on public.ingest_runs for select to authenticated using (true);
