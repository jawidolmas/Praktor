-- Not every message is work. "Thanks" or "good job" gets a reply, not an
-- objective (found live: "Thanks" became an 8-cent run with a Merge button
-- for nothing); something Praktor can't do gets a friendly explanation.
--
-- requests   a new terminal status, 'replied', carrying Praktor's reply.
-- objectives how many files the finished work changed (null when unknown,
--            e.g. objectives from before this was recorded), so the app
--            only offers a merge when there's something to merge.

alter table public.requests drop constraint requests_status_check;
alter table public.requests
  add constraint requests_status_check check (status in ('pending', 'started', 'rejected', 'replied')),
  add column reply text check (char_length(reply) <= 1000);

alter table public.objectives add column changed_files integer check (changed_files >= 0);

-- Same function, plus an optional reply. Dropped and recreated rather than
-- overloaded: a 4-argument call from an older daemon still resolves to this
-- one through the default, instead of being ambiguous between two.
drop function public.settle_request(uuid, text, text, text);

create function public.settle_request(
  p_id uuid,
  p_status text,
  p_objective_id text,
  p_reason text,
  p_reply text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_status not in ('started', 'rejected', 'replied') then
    raise exception 'status must be started, rejected or replied' using errcode = '22023';
  end if;
  update public.requests q
  set status = p_status,
      objective_id = case when p_status = 'started' then left(p_objective_id, 64) end,
      reason = left(p_reason, 500),
      reply = case when p_status = 'replied' then left(p_reply, 1000) end,
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

revoke execute on function public.settle_request(uuid, text, text, text, text) from public, anon;
grant execute on function public.settle_request(uuid, text, text, text, text) to authenticated;
