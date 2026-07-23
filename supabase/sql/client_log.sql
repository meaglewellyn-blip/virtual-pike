-- Client diagnostics log (2026-07-23).
--
-- Every Pike client posts small fire-and-forget rows here on boot and on
-- sync events: which device, which app version, whether its localStorage
-- works, what its local data looks like, and exactly how each pull/push
-- succeeded or failed. Lets a misbehaving device (the frozen iPhone) be
-- diagnosed remotely instead of guessing.
--
-- Safe to re-run.

create table if not exists public.client_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  device text,
  ver text,
  event text,
  detail jsonb
);

alter table public.client_log enable row level security;

drop policy if exists "anon insert client_log" on public.client_log;
create policy "anon insert client_log" on public.client_log
  for insert to anon with check (true);

drop policy if exists "anon read client_log" on public.client_log;
create policy "anon read client_log" on public.client_log
  for select to anon using (true);
