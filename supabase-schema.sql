create table if not exists public.traffic_reports (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 80),
  category text not null check (category in (
    'danger', 'tobidashi', 'signal', 'road', 'local_oneway', 'sidewalk', 'congestion', 'other'
  )),
  direction text not null default '',
  description text not null default '' check (char_length(description) <= 1000),
  location text not null default '' check (char_length(location) <= 120),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  status text not null default 'pending' check (
    status in ('pending', 'investigating', 'resolved')
  ),
  votes bigint not null default 0 check (votes between 0 and 9007199254740991),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

alter table public.traffic_reports
  add column if not exists created_by uuid references auth.users(id) on delete set null;

alter table public.traffic_reports
  add column if not exists direction text not null default '';

alter table public.traffic_reports
  drop constraint if exists traffic_reports_category_check,
  add constraint traffic_reports_category_check check (category in (
    'danger', 'tobidashi', 'signal', 'road', 'local_oneway', 'sidewalk', 'congestion', 'other'
  ));

alter table public.traffic_reports
  drop constraint if exists traffic_reports_direction_check,
  add constraint traffic_reports_direction_check check (
    char_length(direction) <= 120
    and (category <> 'local_oneway' or char_length(btrim(direction)) between 1 and 120)
  );

create table if not exists public.traffic_report_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.traffic_report_admin_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0)
);

create table if not exists public.traffic_report_deletion_logs (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_by_email text,
  report_snapshot jsonb not null,
  deleted_at timestamptz not null default now(),
  ip_address text,
  user_agent text
);

alter table public.traffic_report_deletion_logs
  add column if not exists ip_address text,
  add column if not exists user_agent text;

create index if not exists traffic_report_deletion_logs_deleted_at_idx
  on public.traffic_report_deletion_logs (deleted_at desc);

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.traffic_report_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  label text not null default '' check (char_length(label) <= 80),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table public.traffic_reports
  add column if not exists created_via_invite uuid
  references public.traffic_report_invites(id) on delete set null;

alter table public.traffic_reports enable row level security;
alter table public.traffic_report_admins enable row level security;
alter table public.traffic_report_admin_attempts enable row level security;
alter table public.traffic_report_deletion_logs enable row level security;
alter table public.traffic_report_invites enable row level security;

create or replace function public.is_traffic_report_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.traffic_report_admins
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_traffic_report_admin() from public;
grant execute on function public.is_traffic_report_admin() to authenticated;

drop policy if exists "Users can view own admin membership" on public.traffic_report_admins;
create policy "Users can view own admin membership"
  on public.traffic_report_admins for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Admins can view deletion logs" on public.traffic_report_deletion_logs;
create policy "Admins can view deletion logs"
  on public.traffic_report_deletion_logs for select
  to authenticated
  using (public.is_traffic_report_admin());

drop policy if exists "Admins can view invite links" on public.traffic_report_invites;
create policy "Admins can view invite links"
  on public.traffic_report_invites for select
  to authenticated
  using (public.is_traffic_report_admin());

drop policy if exists "Public reports are viewable" on public.traffic_reports;
create policy "Public reports are viewable"
  on public.traffic_reports for select
  to anon, authenticated
  using (true);

drop policy if exists "Public reports can be created" on public.traffic_reports;
drop policy if exists "Anonymous reports can be created" on public.traffic_reports;
drop policy if exists "Authenticated reports can be created" on public.traffic_reports;
drop policy if exists "Logged-in reports can be created" on public.traffic_reports;
create policy "Logged-in reports can be created"
  on public.traffic_reports for insert
  to authenticated
  with check (
    status = 'pending'
    and votes = 0
    and created_by = (select auth.uid())
    and created_via_invite is null
  );

drop policy if exists "Owners and admins can delete reports" on public.traffic_reports;
create policy "Owners and admins can delete reports"
  on public.traffic_reports for delete
  to authenticated
  using (
    created_by = (select auth.uid())
    or public.is_traffic_report_admin()
  );

revoke all on public.traffic_reports from anon, authenticated;
grant select on public.traffic_reports to anon, authenticated;
grant insert (title, category, direction, description, location, latitude, longitude, created_by)
  on public.traffic_reports to authenticated;
grant delete on public.traffic_reports to authenticated;

revoke all on public.traffic_report_admins from anon, authenticated;
grant select on public.traffic_report_admins to authenticated;
revoke all on public.traffic_report_admin_attempts from public, anon, authenticated;
grant all on public.traffic_report_admin_attempts to service_role;
revoke all on public.traffic_report_deletion_logs from anon, authenticated;
grant select on public.traffic_report_deletion_logs to authenticated;
revoke all on public.traffic_report_invites from anon, authenticated;
grant select on public.traffic_report_invites to authenticated;

create or replace function public.create_traffic_report_invite(p_label text default '')
returns table(invite_id uuid, invite_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_token text;
  new_invite_id uuid;
begin
  if not public.is_traffic_report_admin() then
    raise exception 'Administrator permission required';
  end if;
  if char_length(coalesce(p_label, '')) > 80 then
    raise exception 'Invite label must be 80 characters or fewer';
  end if;

  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.traffic_report_invites (token_hash, label, created_by)
  values (
    encode(extensions.digest(convert_to(raw_token, 'UTF8'), 'sha256'), 'hex'),
    coalesce(p_label, ''),
    (select auth.uid())
  )
  returning id into new_invite_id;

  return query select new_invite_id, raw_token;
end;
$$;

create or replace function public.validate_traffic_report_invite(p_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_token is null or p_token !~ '^[a-f0-9]{64}$' then false
    else exists (
      select 1
      from public.traffic_report_invites
      where token_hash = encode(
        extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'),
        'hex'
      )
        and revoked_at is null
    )
  end;
$$;

create or replace function public.revoke_traffic_report_invite(p_invite_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_rows integer;
begin
  if not public.is_traffic_report_admin() then
    raise exception 'Administrator permission required';
  end if;

  update public.traffic_report_invites
  set revoked_at = now()
  where id = p_invite_id
    and revoked_at is null;
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

drop function if exists public.create_report_with_invite(
  text, text, text, text, text, double precision, double precision
);

create or replace function public.create_report_with_invite(
  p_token text,
  p_title text,
  p_category text,
  p_description text,
  p_location text,
  p_latitude double precision,
  p_longitude double precision,
  p_direction text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite_row public.traffic_report_invites%rowtype;
  new_report_id uuid;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid or revoked invite link';
  end if;

  select *
  into invite_row
  from public.traffic_report_invites
  where token_hash = encode(
    extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'),
    'hex'
  )
    and revoked_at is null
  for share;

  if not found then
    raise exception 'Invalid or revoked invite link';
  end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 80 then
    raise exception 'Title must be between 1 and 80 characters';
  end if;
  if p_category not in ('danger', 'tobidashi', 'signal', 'road', 'local_oneway', 'sidewalk', 'congestion', 'other') then
    raise exception 'Invalid report category';
  end if;
  if char_length(coalesce(p_direction, '')) > 120
    or (p_category = 'local_oneway' and char_length(btrim(coalesce(p_direction, ''))) not between 1 and 120) then
    raise exception 'A valid one-way direction is required';
  end if;
  if char_length(coalesce(p_description, '')) > 1000 then
    raise exception 'Description must be 1000 characters or fewer';
  end if;
  if char_length(coalesce(p_location, '')) > 120 then
    raise exception 'Location must be 120 characters or fewer';
  end if;
  if p_latitude is null or p_latitude not between -90 and 90
    or p_longitude is null or p_longitude not between -180 and 180 then
    raise exception 'Invalid report coordinates';
  end if;

  insert into public.traffic_reports (
    title,
    category,
    direction,
    description,
    location,
    latitude,
    longitude,
    status,
    votes,
    created_by,
    created_via_invite
  )
  values (
    btrim(p_title),
    p_category,
    coalesce(p_direction, ''),
    coalesce(p_description, ''),
    coalesce(p_location, ''),
    p_latitude,
    p_longitude,
    'pending',
    0,
    null,
    invite_row.id
  )
  returning id into new_report_id;

  return new_report_id;
end;
$$;

create or replace function public.list_traffic_report_admins()
returns table(user_id uuid, email text, granted_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select admins.user_id, users.email, admins.created_at
  from public.traffic_report_admins as admins
  join auth.users as users on users.id = admins.user_id
  where public.is_traffic_report_admin()
  order by admins.created_at, users.email;
$$;

create or replace function public.grant_traffic_report_admin(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_rows integer;
begin
  if not public.is_traffic_report_admin() then
    raise exception 'Administrator permission required';
  end if;
  if p_user_id is null then
    raise exception 'A user ID is required';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'User not found';
  end if;

  insert into public.traffic_report_admins (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

create or replace function public.revoke_traffic_report_admin(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_rows integer;
begin
  if not public.is_traffic_report_admin() then
    raise exception 'Administrator permission required';
  end if;
  if p_user_id is null then
    raise exception 'A user ID is required';
  end if;
  if p_user_id = (select auth.uid()) then
    raise exception 'You cannot revoke your own administrator access';
  end if;

  perform pg_advisory_xact_lock(hashtext('traffic_report_admin_revoke'));
  if (select count(*) from public.traffic_report_admins) <= 1 then
    raise exception 'At least one administrator must remain';
  end if;

  delete from public.traffic_report_admins
  where user_id = p_user_id;
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

create or replace function public.delete_all_traffic_reports()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  if not public.is_traffic_report_admin() then
    raise exception 'Administrator permission required';
  end if;

  delete from public.traffic_reports;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.prune_traffic_report_deletion_logs()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_traffic_report_admin() then
    raise exception 'Administrator permission required';
  end if;

  delete from public.traffic_report_deletion_logs
  where deleted_at < now() - interval '90 days';
end;
$$;

revoke all on function public.create_traffic_report_invite(text) from public;
revoke all on function public.validate_traffic_report_invite(text) from public;
revoke all on function public.revoke_traffic_report_invite(uuid) from public;
revoke all on function public.create_report_with_invite(text, text, text, text, text, double precision, double precision, text) from public;
revoke all on function public.list_traffic_report_admins() from public;
revoke all on function public.grant_traffic_report_admin(uuid) from public;
revoke all on function public.revoke_traffic_report_admin(uuid) from public;
revoke all on function public.delete_all_traffic_reports() from public;
revoke all on function public.prune_traffic_report_deletion_logs() from public;
grant execute on function public.create_traffic_report_invite(text) to authenticated;
grant execute on function public.validate_traffic_report_invite(text) to anon, authenticated;
grant execute on function public.revoke_traffic_report_invite(uuid) to authenticated;
grant execute on function public.create_report_with_invite(text, text, text, text, text, double precision, double precision, text) to anon, authenticated;
grant execute on function public.list_traffic_report_admins() to authenticated;
grant execute on function public.grant_traffic_report_admin(uuid) to authenticated;
grant execute on function public.revoke_traffic_report_admin(uuid) to authenticated;
grant execute on function public.delete_all_traffic_reports() to authenticated;
grant execute on function public.prune_traffic_report_deletion_logs() to authenticated;

create or replace function public.log_traffic_report_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_headers jsonb := coalesce(
    nullif(current_setting('request.headers', true), ''),
    '{}'
  )::jsonb;
  source_ip text;
begin
  source_ip := coalesce(
    nullif(btrim(request_headers ->> 'cf-connecting-ip'), ''),
    nullif(btrim(request_headers ->> 'x-real-ip'), ''),
    nullif(btrim(split_part(coalesce(request_headers ->> 'x-forwarded-for', ''), ',', 1)), '')
  );

  insert into public.traffic_report_deletion_logs (
    report_id,
    deleted_by,
    deleted_by_email,
    report_snapshot,
    ip_address,
    user_agent
  )
  values (
    old.id,
    (select auth.uid()),
    (select auth.jwt() ->> 'email'),
    to_jsonb(old),
    source_ip,
    nullif(request_headers ->> 'user-agent', '')
  );

  return old;
end;
$$;

revoke all on function public.log_traffic_report_deletion() from public;

drop trigger if exists traffic_reports_audit_delete on public.traffic_reports;
create trigger traffic_reports_audit_delete
  after delete on public.traffic_reports
  for each row execute function public.log_traffic_report_deletion();

create or replace function public.prune_traffic_report_deletion_logs_after_report_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.traffic_report_deletion_logs
  where deleted_at < now() - interval '90 days';
  return null;
end;
$$;

revoke all on function public.prune_traffic_report_deletion_logs_after_report_delete() from public;

drop trigger if exists traffic_report_deletion_logs_retention on public.traffic_reports;
create trigger traffic_report_deletion_logs_retention
  after delete on public.traffic_reports
  for each statement execute function public.prune_traffic_report_deletion_logs_after_report_delete();

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

create or replace function public.reserve_traffic_report_admin_attempt(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  if p_user_id is null then
    raise exception 'User ID is required';
  end if;

  insert into public.traffic_report_admin_attempts (user_id, window_started_at, attempts)
  values (p_user_id, now(), 1)
  on conflict (user_id) do update
  set
    window_started_at = case
      when public.traffic_report_admin_attempts.window_started_at <= now() - interval '1 hour'
        then now()
      else public.traffic_report_admin_attempts.window_started_at
    end,
    attempts = case
      when public.traffic_report_admin_attempts.window_started_at <= now() - interval '1 hour'
        then 1
      else public.traffic_report_admin_attempts.attempts + 1
    end
  returning attempts into v_attempts;

  return v_attempts <= 5;
end;
$$;

revoke all on function public.reserve_traffic_report_admin_attempt(uuid) from public, anon, authenticated;
grant execute on function public.reserve_traffic_report_admin_attempt(uuid) to service_role;

create table if not exists public.nominatim_search_cache (
  query_key text primary key,
  results jsonb not null,
  expires_at timestamptz not null
);

create table if not exists public.nominatim_request_gate (
  id smallint primary key check (id = 1),
  next_allowed_at timestamptz not null
);

insert into public.nominatim_request_gate (id, next_allowed_at)
values (1, '-infinity'::timestamptz)
on conflict (id) do nothing;

alter table public.nominatim_search_cache enable row level security;
alter table public.nominatim_request_gate enable row level security;
revoke all on table public.nominatim_search_cache from public, anon, authenticated;
revoke all on table public.nominatim_request_gate from public, anon, authenticated;
grant all on table public.nominatim_search_cache to service_role;
grant all on table public.nominatim_request_gate to service_role;

create or replace function public.reserve_nominatim_search(p_query text)
returns table (
  query_key text,
  cached_results jsonb,
  cache_hit boolean,
  request_allowed boolean,
  retry_after_ms integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_query_key text;
  v_cached_results jsonb;
  v_next_allowed_at timestamptz;
  v_now timestamptz;
begin
  if p_query is null or char_length(btrim(p_query)) not between 2 and 200 then
    raise exception 'Query must be between 2 and 200 characters';
  end if;

  v_query_key := encode(
    extensions.digest(convert_to(lower(btrim(p_query)), 'UTF8'), 'sha256'),
    'hex'
  );

  select cache.results
  into v_cached_results
  from public.nominatim_search_cache as cache
  where cache.query_key = v_query_key
    and cache.expires_at > clock_timestamp();

  if found then
    return query select v_query_key, v_cached_results, true, false, 0;
    return;
  end if;

  select gate.next_allowed_at
  into v_next_allowed_at
  from public.nominatim_request_gate as gate
  where gate.id = 1
  for update;

  v_now := clock_timestamp();
  if v_next_allowed_at > v_now then
    return query
      select
        v_query_key,
        null::jsonb,
        false,
        false,
        greatest(1, ceil(extract(epoch from (v_next_allowed_at - v_now)) * 1000)::integer);
    return;
  end if;

  update public.nominatim_request_gate
  set next_allowed_at = v_now + interval '1 second'
  where id = 1;

  return query select v_query_key, null::jsonb, false, true, 0;
end;
$$;

revoke all on function public.reserve_nominatim_search(text) from public, anon, authenticated;
grant execute on function public.reserve_nominatim_search(text) to service_role;
