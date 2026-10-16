-- Progress lines from the nightly job, so problems can be diagnosed without GitHub logs.
create table if not exists public.ingest_log (
  id     bigserial primary key,
  run_id bigint references public.ingest_runs(id) on delete cascade,
  at     timestamptz not null default now(),
  msg    text not null
);
create index if not exists ingest_log_run_idx on public.ingest_log (run_id);
alter table public.ingest_log enable row level security;
create policy "read ingest_log" on public.ingest_log for select to authenticated using (true);
