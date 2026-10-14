-- "Say what you want" from the phone: a conversation of requests, each one
-- turned into an objective by the computer it's addressed to.
--
-- repos     each computer's repos by folder NAME only (never a path), keyed
--           by an opaque hash the computer maps back to the real folder.
-- requests  messages from the phone. Written only through send_request(),
--           which checks the computer and the repo, bounds the message, is
--           idempotent on the phone-generated id, and rate-limits — every
--           request spends real money on the owner's Claude plan.

create table public.repos (
  owner_id uuid not null references auth.users (id) on delete cascade,
  host_id uuid not null references public.hosts (id) on delete cascade,
  key text not null check (key ~ '^[0-9a-f]{16}$'),
  name text not null check (char_length(name) between 1 and 200),
  last_used_at bigint,
  updated_at bigint not null,
  primary key (owner_id, host_id, key)
);

alter table public.repos enable row level security;
revoke all on public.repos from anon, authenticated;
grant select, insert, update, delete on public.repos to authenticated;

create policy repos_select on public.repos for select to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_host_of(owner_id)));
create policy repos_insert on public.repos for insert to authenticated
  with check (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)));
create policy repos_update on public.repos for update to authenticated
  using (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)))
  with check (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)));
create policy repos_delete on public.repos for delete to authenticated
  using (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)));

create table public.requests (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  host_id uuid not null references public.hosts (id) on delete cascade,
  thread_id uuid not null,
  repo_key text not null,
  repo_name text not null,
  message text not null check (char_length(message) between 1 and 4000),
  status text not null default 'pending' check (status in ('pending', 'started', 'rejected')),
  objective_id text,
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index requests_thread_idx on public.requests (owner_id, thread_id, created_at);
create index requests_recent_idx on public.requests (owner_id, created_at desc);
create index requests_pending_idx on public.requests (host_id) where status = 'pending';

alter table public.requests enable row level security;
revoke all on public.requests from anon, authenticated;
grant select on public.requests to authenticated;

create policy requests_select on public.requests for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)))
  );

/** Requests one owner may send per hour — a stolen session can't run up the
 *  owner's Claude bill by firing hundreds of objectives. */
create function public.request_rate_limit() returns integer language sql immutable as $$ select 30 $$;

/** Called by the phone. Idempotent on the phone-generated id: a retry over a
 *  flaky connection returns the original request instead of starting the
 *  work twice. */
create function public.send_request(
  p_id uuid,
  p_thread_id uuid,
  p_host_id uuid,
  p_repo_key text,
  p_message text
)
returns public.requests
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  msg text := btrim(coalesce(p_message, ''));
  r public.repos;
  result public.requests;
begin
  if uid is null or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'sign in to send a request' using errcode = '28000';
  end if;

  select * into result from public.requests where id = p_id;
  if found then
    if result.owner_id = uid then
      return result;
    end if;
    raise exception 'request id already used' using errcode = '23505';
  end if;

  if char_length(msg) not between 1 and 4000 then
    raise exception 'a request must be 1-4000 characters' using errcode = '22023';
  end if;
  -- A conversation belongs to whoever started it.
  if exists (select 1 from public.requests where thread_id = p_thread_id and owner_id <> uid) then
    raise exception 'no such conversation' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.hosts h where h.id = p_host_id and h.owner_id = uid and h.revoked_at is null
  ) then
    raise exception 'that computer is not connected to your account' using errcode = '42501';
  end if;
  select * into r from public.repos where owner_id = uid and host_id = p_host_id and key = p_repo_key;
  if not found then
    raise exception 'that repo is not on that computer' using errcode = 'P0002';
  end if;
  if (
    select count(*) from public.requests where owner_id = uid and created_at > now() - interval '1 hour'
  ) >= public.request_rate_limit() then
    raise exception 'too many requests — try again later' using errcode = '54000';
  end if;

  insert into public.requests (id, owner_id, host_id, thread_id, repo_key, repo_name, message)
  values (p_id, uid, p_host_id, p_thread_id, r.key, r.name, msg)
  returning * into result;
  return result;
end;
$$;

/** Called by the computer once it has started the objective, or refused. */
create function public.settle_request(p_id uuid, p_status text, p_objective_id text, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_status not in ('started', 'rejected') then
    raise exception 'status must be started or rejected' using errcode = '22023';
  end if;
  update public.requests q
  set status = p_status,
      objective_id = case when p_status = 'started' then left(p_objective_id, 64) end,
      reason = left(p_reason, 500),
      settled_at = now()
  where q.id = p_id
    and q.host_id = (select auth.uid())
    and q.status = 'pending'
    and exists (
      select 1 from public.hosts h
      where h.id = q.host_id and h.owner_id = q.owner_id and h.revoked_at is null
    );
  return found;
end;
$$;

revoke execute on function public.send_request(uuid, uuid, uuid, text, text) from public, anon;
revoke execute on function public.settle_request(uuid, text, text, text) from public, anon;
revoke execute on function public.request_rate_limit() from public, anon;
grant execute on function public.send_request(uuid, uuid, uuid, text, text) to authenticated;
grant execute on function public.settle_request(uuid, text, text, text) to authenticated;
grant execute on function public.request_rate_limit() to authenticated;

alter publication supabase_realtime add table public.repos, public.requests;
