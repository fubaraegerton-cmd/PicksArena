-- =====================================================================
-- Live data feed bookkeeping (TheSportsDB).
-- feed_state records when the importer last ran; claim_feed_run lets one
-- request at a time take the next run so concurrent visitors don't all
-- call the feed.
-- =====================================================================

create table public.feed_state (
  key text primary key,
  last_run timestamptz,
  last_ok timestamptz,
  last_result jsonb,
  last_error text
);
alter table public.feed_state enable row level security;
revoke all on public.feed_state from anon, authenticated;

create or replace function public.claim_feed_run(p_key text, p_every_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  insert into public.feed_state (key, last_run) values (p_key, now())
  on conflict (key) do update
    set last_run = now()
    where public.feed_state.last_run is null
       or public.feed_state.last_run < now() - make_interval(secs => p_every_seconds)
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_feed_run(text, int) from public, anon, authenticated;
grant execute on function public.claim_feed_run(text, int) to service_role;
