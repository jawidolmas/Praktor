-- Praktor relay: a read-only mirror of the local daemon's state, so the iOS
-- app can follow it from any network without a VPN.
--
-- Data scope is "level B": status, costs, decisions, readable event
-- summaries, and the *paths* of files each agent changed. Never file
-- contents or diffs — source code stays on the PC.
--
-- Trust model:
--   owner  a person, signed in on the phone (never anonymous). Reads only.
--   host   a PC running the daemon, signed in as its own anonymous user and
--          claimed by exactly one owner via a single-use code. Writes only
--          its own rows, into its owner's data. Revocable.
-- No client ever holds the service_role key.

-- ------------------------------------------------------------------
-- Hosts and claiming
-- ------------------------------------------------------------------

create table public.hosts (
  id uuid primary key references auth.users (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 64),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  check (id <> owner_id)
);
create index hosts_owner_idx on public.hosts (owner_id);

-- Only ever touched through the security-definer functions below; RLS is on
-- with no policies, so no client can read or write it directly.
create table public.host_claims (
  code_hash bytea primary key,
  host_id uuid not null unique references auth.users (id) on delete cascade,
  name text not null,
  expires_at timestamptz not null
);

alter table public.hosts enable row level security;
alter table public.host_claims enable row level security;

create policy hosts_select on public.hosts for select to authenticated
  using (owner_id = (select auth.uid()) or id = (select auth.uid()));

revoke all on public.hosts from anon, authenticated;
grant select on public.hosts to authenticated;
revoke all on public.host_claims from anon, authenticated;

/** True when the caller is an active (unrevoked) host of `owner`. */
create function public.is_host_of(owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.hosts h
    where h.id = (select auth.uid()) and h.owner_id = owner and h.revoked_at is null
  );
$$;

/** Called by the PC: returns a fresh single-use claim code (10 minutes). */
create function public.create_host_claim(p_name text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  clean_name text := btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g'));
  code text;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if exists (select 1 from public.hosts where id = uid) then
    raise exception 'this host is already claimed' using errcode = '42501';
  end if;
  if char_length(clean_name) not between 1 and 64 then
    raise exception 'host name must be 1-64 characters' using errcode = '22023';
  end if;

  -- Two v4 UUIDs: 244 random bits from the server's CSPRNG.
  code := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  delete from public.host_claims where host_id = uid or expires_at < now();
  insert into public.host_claims (code_hash, host_id, name, expires_at)
  values (sha256(convert_to(code, 'UTF8')), uid, clean_name, now() + interval '10 minutes');
  return code;
end;
$$;

/** Called by the phone: redeems a claim code, making that PC a host of the
 *  caller. Single-use (the claim row is consumed atomically). */
create function public.claim_host(p_code text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  claimed_host uuid;
  claimed_name text;
begin
  if uid is null or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'sign in to claim a host' using errcode = '28000';
  end if;
  if p_code is null or char_length(p_code) <> 64 then
    raise exception 'invalid or expired code' using errcode = '22023';
  end if;

  delete from public.host_claims
  where code_hash = sha256(convert_to(p_code, 'UTF8')) and expires_at > now()
  returning host_id, name into claimed_host, claimed_name;

  if claimed_host is null then
    raise exception 'invalid or expired code' using errcode = '22023';
  end if;
  if claimed_host = uid then
    raise exception 'a host cannot claim itself' using errcode = '42501';
  end if;

  insert into public.hosts (id, owner_id, name) values (claimed_host, uid, claimed_name);
  return claimed_host;
end;
$$;

/** Called by the phone: cuts a host off. Its data stays readable. */
create function public.revoke_host(p_host uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.hosts set revoked_at = now()
  where id = p_host and owner_id = (select auth.uid()) and revoked_at is null;
  return found;
end;
$$;

/** Called by the PC: marks it as alive, so the app can say "offline". */
create function public.host_heartbeat()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.hosts set last_seen_at = now()
  where id = (select auth.uid()) and revoked_at is null;
$$;

revoke execute on function public.is_host_of(uuid) from public, anon;
revoke execute on function public.create_host_claim(text) from public, anon;
revoke execute on function public.claim_host(text) from public, anon;
revoke execute on function public.revoke_host(uuid) from public, anon;
revoke execute on function public.host_heartbeat() from public, anon;
grant execute on function public.is_host_of(uuid) to authenticated;
grant execute on function public.create_host_claim(text) to authenticated;
grant execute on function public.claim_host(text) to authenticated;
grant execute on function public.revoke_host(uuid) to authenticated;
grant execute on function public.host_heartbeat() to authenticated;

-- ------------------------------------------------------------------
-- Mirror tables. Timestamps are epoch milliseconds, matching the local
-- SQLite schema exactly so sync never converts them. Every row carries
-- owner_id (whose data) and host_id (which PC wrote it).
-- ------------------------------------------------------------------

create table public.objectives (
  owner_id uuid not null references auth.users (id) on delete cascade,
  host_id uuid not null references public.hosts (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  title text not null check (char_length(title) <= 500),
  repo_name text not null check (char_length(repo_name) <= 200),
  status text not null check (char_length(status) <= 32),
  model text not null check (char_length(model) <= 64),
  effort text not null check (char_length(effort) <= 16),
  cost_usd double precision not null default 0,
  merged_at bigint,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (owner_id, id)
);
create index objectives_owner_updated_idx on public.objectives (owner_id, updated_at desc);

create table public.tasks (
  owner_id uuid not null,
  host_id uuid not null references public.hosts (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  objective_id text not null,
  key text not null check (char_length(key) <= 32),
  title text not null check (char_length(title) <= 500),
  task_class text not null check (char_length(task_class) <= 32),
  status text not null check (char_length(status) <= 32),
  attempts integer not null,
  max_attempts integer not null,
  depends_on jsonb not null default '[]' check (jsonb_typeof(depends_on) = 'array'),
  model text not null check (char_length(model) <= 64),
  created_at bigint not null,
  updated_at bigint not null,
  primary key (owner_id, id),
  foreign key (owner_id, objective_id) references public.objectives (owner_id, id) on delete cascade
);
create index tasks_objective_idx on public.tasks (owner_id, objective_id);

create table public.runs (
  owner_id uuid not null,
  host_id uuid not null references public.hosts (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  task_id text not null,
  objective_id text not null,
  attempt integer not null,
  model text not null check (char_length(model) <= 64),
  effort text not null check (char_length(effort) <= 16),
  status text not null check (char_length(status) <= 32),
  exit_reason text check (char_length(exit_reason) <= 64),
  turns integer not null default 0,
  cost_usd double precision not null default 0,
  started_at bigint not null,
  ended_at bigint,
  primary key (owner_id, id),
  foreign key (owner_id, task_id) references public.tasks (owner_id, id) on delete cascade
);
create index runs_objective_idx on public.runs (owner_id, objective_id);

-- Readable one-line summaries only (the same text the dashboard shows), never
-- raw payloads. Local event ids are per-host, hence host_id in the key.
create table public.events (
  owner_id uuid not null references auth.users (id) on delete cascade,
  host_id uuid not null references public.hosts (id) on delete cascade,
  id bigint not null,
  objective_id text,
  task_id text,
  ts bigint not null,
  level text not null check (char_length(level) <= 16),
  type text not null check (char_length(type) <= 64),
  kind text not null check (char_length(kind) <= 16),
  text text not null check (char_length(text) <= 2000),
  model text check (char_length(model) <= 64),
  primary key (owner_id, host_id, id)
);
create index events_objective_idx on public.events (owner_id, objective_id, id);
create index events_ts_idx on public.events (owner_id, ts desc);

create table public.decisions (
  owner_id uuid not null,
  host_id uuid not null references public.hosts (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  key text not null check (char_length(key) <= 32),
  objective_id text not null,
  task_id text,
  level text not null check (char_length(level) <= 8),
  title text not null check (char_length(title) <= 500),
  context text not null check (char_length(context) <= 8000),
  options jsonb not null check (jsonb_typeof(options) = 'array'),
  recommendation text not null check (char_length(recommendation) <= 200),
  risk text not null check (char_length(risk) <= 2000),
  status text not null check (char_length(status) <= 32),
  answer text check (char_length(answer) <= 200),
  answered_by text check (char_length(answered_by) <= 200),
  answered_at bigint,
  created_at bigint not null,
  primary key (owner_id, id),
  foreign key (owner_id, objective_id) references public.objectives (owner_id, id) on delete cascade
);
create index decisions_status_idx on public.decisions (owner_id, status);

-- Paths only: what each task's latest attempt added / modified / deleted /
-- renamed. The app builds the agent's tree from these.
create table public.agent_files (
  owner_id uuid not null,
  host_id uuid not null references public.hosts (id) on delete cascade,
  task_id text not null,
  path text not null check (char_length(path) <= 1024),
  objective_id text not null,
  attempt integer not null,
  change text not null check (change in ('A', 'M', 'D', 'R', 'C', 'T', 'U', 'X')),
  old_path text check (char_length(old_path) <= 1024),
  primary key (owner_id, task_id, path),
  foreign key (owner_id, task_id) references public.tasks (owner_id, id) on delete cascade
);
create index agent_files_objective_idx on public.agent_files (owner_id, objective_id);

-- Whole-dashboard aggregates the graphs read (health, costs, profile,
-- daemon status), replaced wholesale on each sync.
create table public.snapshots (
  owner_id uuid not null references auth.users (id) on delete cascade,
  host_id uuid not null references public.hosts (id) on delete cascade,
  kind text not null check (kind in ('health', 'costs', 'profile', 'daemon', 'policies')),
  data jsonb not null check (pg_column_size(data) <= 262144),
  updated_at bigint not null,
  primary key (owner_id, host_id, kind)
);

-- ------------------------------------------------------------------
-- RLS for every mirror table, identical by construction:
--   read   the owner, or any active host of that owner
--   write  only an active host, only rows stamped with its own host_id
-- ------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['objectives', 'tasks', 'runs', 'events', 'decisions', 'agent_files', 'snapshots']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);

    execute format(
      'create policy %I on public.%I for select to authenticated
         using (owner_id = (select auth.uid()) or (select public.is_host_of(owner_id)))',
      t || '_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated
         with check (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)))',
      t || '_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated
         using (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)))
         with check (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)))',
      t || '_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated
         using (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)))',
      t || '_delete', t);
  end loop;
end;
$$;

-- Live updates for the app. Realtime enforces the same RLS per subscriber.
alter publication supabase_realtime add table
  public.hosts, public.objectives, public.tasks, public.runs, public.events,
  public.decisions, public.agent_files, public.snapshots;
