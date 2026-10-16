-- How the user buys a list term: by weight or packaged, and how much.
create table if not exists public.term_settings (
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  term      text not null,
  mode      text check (mode in ('weight', 'pack')),
  weight_kg numeric check (weight_kg > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, term)
);
alter table public.term_settings enable row level security;
create policy "own term settings" on public.term_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
