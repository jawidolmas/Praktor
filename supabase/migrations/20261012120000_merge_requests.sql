-- "Merge and push" requested from the phone, carried out by the PC.
--
-- Same shape as decision_answers: the phone can't write this table, only
-- call request_merge(), which accepts the caller's own finished, unmerged
-- objective while the computer that ran it is still connected. Only that
-- computer can read the request and settle it, and it merges through the
-- same lock-guarded path as the dashboard's Merge button and
-- `exec-agent approve` — refusing a dirty repo, a detached HEAD, or a merge
-- already in progress elsewhere.

create table public.merge_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  host_id uuid not null references public.hosts (id) on delete cascade,
  objective_id text not null,
  status text not null default 'pending' check (status in ('pending', 'merged', 'failed')),
  message text check (char_length(message) <= 1000),
  pushed boolean,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
-- At most one request in flight per objective; a failed one (say, a merge
-- conflict the person then resolves) can be followed by a new request.
create unique index merge_requests_one_pending_idx on public.merge_requests (owner_id, objective_id)
  where status = 'pending';
create index merge_requests_objective_idx on public.merge_requests (owner_id, objective_id, created_at desc);

alter table public.merge_requests enable row level security;
revoke all on public.merge_requests from anon, authenticated;
grant select on public.merge_requests to authenticated;

create policy merge_requests_select on public.merge_requests for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)))
  );

/** Called by the phone. Idempotent: while a request for this objective is
 *  still pending, asking again returns that same request. */
create function public.request_merge(p_objective_id text)
returns public.merge_requests
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  o public.objectives;
  result public.merge_requests;
begin
  if uid is null or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'sign in to merge' using errcode = '28000';
  end if;

  select * into result from public.merge_requests
  where owner_id = uid and objective_id = p_objective_id and status = 'pending';
  if found then
    return result;
  end if;

  select * into o from public.objectives where owner_id = uid and id = p_objective_id;
  if not found then
    raise exception 'no such objective' using errcode = 'P0002';
  end if;
  if o.merged_at is not null then
    raise exception 'this objective is already merged' using errcode = '23505';
  end if;
  if o.status <> 'done' then
    raise exception 'this objective is not finished' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.hosts h where h.id = o.host_id and h.owner_id = uid and h.revoked_at is null
  ) then
    raise exception 'the computer that ran it was removed' using errcode = '42501';
  end if;

  insert into public.merge_requests (owner_id, host_id, objective_id)
  values (uid, o.host_id, o.id)
  on conflict (owner_id, objective_id) where status = 'pending' do nothing
  returning * into result;

  -- Lost a race with a concurrent identical request: return the winner.
  if result.id is null then
    select * into result from public.merge_requests
    where owner_id = uid and objective_id = p_objective_id and status = 'pending';
  end if;
  return result;
end;
$$;

/** Called by the PC once the merge has run (or was refused). Only the
 *  computer it was addressed to, only while it's still an active host, and
 *  only once. */
create function public.settle_merge_request(p_id uuid, p_status text, p_message text, p_pushed boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_status not in ('merged', 'failed') then
    raise exception 'status must be merged or failed' using errcode = '22023';
  end if;
  update public.merge_requests r
  set status = p_status, message = left(p_message, 1000), pushed = p_pushed, settled_at = now()
  where r.id = p_id
    and r.host_id = (select auth.uid())
    and r.status = 'pending'
    and exists (
      select 1 from public.hosts h
      where h.id = r.host_id and h.owner_id = r.owner_id and h.revoked_at is null
    );
  return found;
end;
$$;

revoke execute on function public.request_merge(text) from public, anon;
revoke execute on function public.settle_merge_request(uuid, text, text, boolean) from public, anon;
grant execute on function public.request_merge(text) to authenticated;
grant execute on function public.settle_merge_request(uuid, text, text, boolean) to authenticated;

alter publication supabase_realtime add table public.merge_requests;
