-- Settings the app reads, written by the nightly job: the public key push notifications are
-- signed with (its private half is in Supabase's vault, created there by ingest/alerts.py).
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
alter table public.app_config enable row level security;
create policy "signed-in users read" on public.app_config for select to authenticated using (true);
grant select on public.app_config to authenticated;
grant select, insert, update, delete on public.app_config to service_role;
