create table if not exists public.traffic_reports (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 80),
  category text not null check (category in (
    'danger', 'tobidashi', 'signal', 'road', 'sidewalk', 'congestion', 'other'
  )),
  description text not null default '' check (char_length(description) <= 1000),
  location text not null default '' check (char_length(location) <= 120),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  status text not null default 'pending' check (
    status in ('pending', 'investigating', 'resolved')
  ),
  votes bigint not null default 0 check (votes between 0 and 9007199254740991),
  created_at timestamptz not null default now()
);

alter table public.traffic_reports enable row level security;

drop policy if exists "Public reports are viewable" on public.traffic_reports;
create policy "Public reports are viewable"
  on public.traffic_reports for select
  to anon, authenticated
  using (true);

drop policy if exists "Public reports can be created" on public.traffic_reports;
create policy "Public reports can be created"
  on public.traffic_reports for insert
  to anon, authenticated
  with check (status = 'pending' and votes = 0);

revoke all on public.traffic_reports from anon, authenticated;
grant select on public.traffic_reports to anon, authenticated;
grant insert (title, category, description, location, latitude, longitude)
  on public.traffic_reports to anon, authenticated;

create or replace function public.increment_report_votes(target_report_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_votes bigint;
begin
  update public.traffic_reports
  set votes = votes + 1
  where id = target_report_id
    and votes < 9007199254740991
  returning votes into updated_votes;

  return updated_votes;
end;
$$;

revoke all on function public.increment_report_votes(uuid) from public;
grant execute on function public.increment_report_votes(uuid) to anon, authenticated;
