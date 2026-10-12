-- Answers to decisions, sent from the phone and applied by the PC.
--
-- The phone never writes this table directly: it calls answer_decision(),
-- which accepts an answer only for the caller's own, still-open decision,
-- only if it's one of that decision's listed options, and only while the
-- computer that raised it is still connected. The PC that raised the
-- decision is the only one that can read the answer and settle it, and it
-- applies it through the same local code path as the CLI, dashboard and
-- Telegram — so every channel gets the same checks and the same audit trail.

create table public.decision_answers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  host_id uuid not null references public.hosts (id) on delete cascade,
  decision_id text not null,
  decision_key text not null,
  answer text not null check (char_length(answer) <= 200),
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
  message text check (char_length(message) <= 500),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  -- One answer per decision from the app: a retry can't create a second.
  unique (owner_id, decision_id)
);
create index decision_answers_pending_idx on public.decision_answers (host_id) where status = 'pending';

alter table public.decision_answers enable row level security;
revoke all on public.decision_answers from anon, authenticated;
grant select on public.decision_answers to authenticated;

create policy decision_answers_select on public.decision_answers for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (host_id = (select auth.uid()) and (select public.is_host_of(owner_id)))
  );

/** Called by the phone. Idempotent: repeating the same answer returns the
 *  original record; a different answer to an already-answered decision is
 *  refused rather than overwriting it. */
create function public.answer_decision(p_decision_id text, p_answer text)
returns public.decision_answers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  d public.decisions;
  result public.decision_answers;
begin
  if uid is null or coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'sign in to answer' using errcode = '28000';
  end if;

  select * into result from public.decision_answers where owner_id = uid and decision_id = p_decision_id;
  if found then
    if result.answer = p_answer then
      return result;
    end if;
    raise exception 'this decision was already answered' using errcode = '23505';
  end if;

  select * into d from public.decisions where owner_id = uid and id = p_decision_id;
  if not found then
    raise exception 'no such decision' using errcode = 'P0002';
  end if;
  if d.status <> 'open' then
    raise exception 'this decision was already answered' using errcode = '23505';
  end if;
  if not exists (select 1 from jsonb_array_elements(d.options) o where o ->> 'id' = p_answer) then
    raise exception 'that is not one of the options' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.hosts h where h.id = d.host_id and h.owner_id = uid and h.revoked_at is null
  ) then
    raise exception 'the computer that asked was removed' using errcode = '42501';
  end if;

  insert into public.decision_answers (owner_id, host_id, decision_id, decision_key, answer)
  values (uid, d.host_id, d.id, d.key, p_answer)
  on conflict (owner_id, decision_id) do nothing
  returning * into result;

  -- Lost a race with a concurrent identical request: hand back the winner,
  -- under the same same-answer rule as above.
  if result.id is null then
    select * into result from public.decision_answers where owner_id = uid and decision_id = p_decision_id;
    if result.answer <> p_answer then
      raise exception 'this decision was already answered' using errcode = '23505';
    end if;
  end if;
  return result;
end;
$$;

/** Called by the PC once it has applied (or had to refuse) an answer. Only
 *  the computer the answer was addressed to, only while it's still an
 *  active host, and only once. */
create function public.settle_decision_answer(p_id uuid, p_status text, p_message text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_status not in ('applied', 'rejected') then
    raise exception 'status must be applied or rejected' using errcode = '22023';
  end if;
  update public.decision_answers a
  set status = p_status, message = left(p_message, 500), settled_at = now()
  where a.id = p_id
    and a.host_id = (select auth.uid())
    and a.status = 'pending'
    and exists (
      select 1 from public.hosts h
      where h.id = a.host_id and h.owner_id = a.owner_id and h.revoked_at is null
    );
  return found;
end;
$$;

revoke execute on function public.answer_decision(text, text) from public, anon;
revoke execute on function public.settle_decision_answer(uuid, text, text) from public, anon;
grant execute on function public.answer_decision(text, text) to authenticated;
grant execute on function public.settle_decision_answer(uuid, text, text) to authenticated;

alter publication supabase_realtime add table public.decision_answers;
