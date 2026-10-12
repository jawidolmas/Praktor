-- Each computer reports what its running Praktor can do, so the phone knows
-- before you tap — e.g. that a daemon still running an older build can't
-- carry out a merge yet — instead of waiting on a request nothing will pick
-- up. A daemon that never reports (any build from before this) keeps an
-- empty list, which the app reads as "needs an update / restart".

alter table public.hosts
  add column capabilities text[] not null default '{}',
  add column agent_version text check (char_length(agent_version) <= 32);

/** The newer heartbeat: liveness plus what this computer can do. The old
 *  no-argument host_heartbeat() stays, so older daemons keep working. */
create function public.host_heartbeat(p_capabilities text[], p_version text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.hosts
  set last_seen_at = now(),
      -- Bounded: a host can't stuff arbitrary data into its own row.
      capabilities = coalesce((
        select array_agg(c) from unnest(p_capabilities[1:16]) as c where char_length(c) between 1 and 32
      ), '{}'),
      agent_version = left(p_version, 32)
  where id = (select auth.uid()) and revoked_at is null;
$$;

revoke execute on function public.host_heartbeat(text[], text) from public, anon;
grant execute on function public.host_heartbeat(text[], text) to authenticated;
