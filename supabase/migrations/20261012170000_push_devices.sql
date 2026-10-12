-- Phones that want push notifications. The phone registers its Expo push
-- token here; the owner's own computers read it to notify that phone when
-- a decision needs them or work finishes. Nobody else can see a token.
-- Registration goes only through functions: no client writes rows directly.

create table public.push_devices (
  token text primary key
    check (char_length(token) between 20 and 200 and token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_\-]+\]$'),
  owner_id uuid not null references auth.users (id) on delete cascade,
  device_name text check (char_length(device_name) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index push_devices_owner_idx on public.push_devices (owner_id);

alter table public.push_devices enable row level security;
revoke all on public.push_devices from anon, authenticated;
grant select on public.push_devices to authenticated;

create policy push_devices_select on public.push_devices for select to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_host_of(owner_id)));

/** Called by the phone after the person turns notifications on. A token
 *  presented again from a phone now signed into another account moves to
 *  that account: whoever holds the token is the phone's current user. */
create function public.register_push_device(p_token text, p_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'sign in to turn on notifications' using errcode = '28000';
  end if;
  insert into public.push_devices (token, owner_id, device_name)
  values (p_token, uid, nullif(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 64), ''))
  on conflict (token) do update
    set owner_id = excluded.owner_id, device_name = excluded.device_name, updated_at = now();
end;
$$;

/** Called by the phone when notifications are turned off or on sign-out. */
create function public.unregister_push_device(p_token text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.push_devices where token = p_token and owner_id = (select auth.uid());
$$;

/** Called by a computer when Expo reports a token is no longer valid (the
 *  app was deleted), so it stops being notified. Only for its owner's tokens. */
create function public.drop_push_device(p_token text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.push_devices d
  where d.token = p_token
    and exists (
      select 1 from public.hosts h
      where h.id = (select auth.uid()) and h.owner_id = d.owner_id and h.revoked_at is null
    );
$$;

revoke execute on function public.register_push_device(text, text) from public, anon;
revoke execute on function public.unregister_push_device(text) from public, anon;
revoke execute on function public.drop_push_device(text) from public, anon;
grant execute on function public.register_push_device(text, text) to authenticated;
grant execute on function public.unregister_push_device(text) to authenticated;
grant execute on function public.drop_push_device(text) to authenticated;
