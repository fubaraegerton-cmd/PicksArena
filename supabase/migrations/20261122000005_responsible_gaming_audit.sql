-- =====================================================================
-- Phase 5: responsible gaming, audit log, rate limiting.
--
--   * player_limits    — deposit / stake / loss limits per rolling day, week, month.
--                        Append-only history. Stricter limits apply immediately;
--                        raising or removing one only takes effect after 24 hours.
--   * player_exclusions — cool-off (1/7/30 days) and self-exclusion (6m/1y/5y/permanent).
--                        Can be extended, never shortened (not even by an operator).
--   * audit_log        — append-only record of every money movement, payment status,
--                        KYC decision, limit, exclusion, account hold, state switch and
--                        line/result change. Operator actions add their identity.
--   * rate_limits      — fixed-window counters used by the server per player/action.
--   start_deposit and place_entry now enforce limits inside the database.
-- =====================================================================

-- ---------- limits ----------------------------------------------------------
create table public.player_limits (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  kind text not null check (kind in ('deposit', 'stake', 'loss')),
  period text not null check (period in ('day', 'week', 'month')),
  amount_cents bigint check (amount_cents is null or (amount_cents > 0 and amount_cents <= 10000000)),  -- null = no limit
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by text not null
);
create index on public.player_limits (user_id, kind, period, id desc);
create trigger player_limits_append_only before update or delete on public.player_limits
  for each row execute function public.forbid_mutation();

create function public.period_start(p_period text) returns timestamptz
language sql stable as $$
  select now() - case p_period when 'day' then interval '24 hours' when 'week' then interval '7 days' else interval '30 days' end
$$;

-- The limit in force right now: the newest request whose effective time has arrived.
create function public.current_limit(p_user uuid, p_kind text, p_period text) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select amount_cents from public.player_limits
   where user_id = p_user and kind = p_kind and period = p_period and effective_at <= now()
   order by id desc limit 1
$$;

-- How much of a limit has been used since p_since.
--   deposit: deposits started or completed (pending checkouts count, so parallel checkouts can't exceed it)
--   stake:   amount staked on entries
--   loss:    amount staked minus everything paid back (wins and refunds) in the window
create function public.limit_usage(p_user uuid, p_kind text, p_since timestamptz) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_kind
    when 'deposit' then (select coalesce(sum(amount_cents), 0) from public.payments
                          where user_id = p_user and direction = 'deposit' and status in ('created', 'succeeded') and created_at >= p_since)
    when 'stake' then (select coalesce(sum(stake_cents), 0) from public.entries where user_id = p_user and created_at >= p_since)
    else greatest(0,
           (select coalesce(sum(stake_cents), 0) from public.entries where user_id = p_user and created_at >= p_since)
         - (select coalesce(sum(payout_cents), 0) from public.entries where user_id = p_user and settled_at >= p_since))
  end::bigint
$$;

create function public.enforce_limits(p_user uuid, p_kind text, p_amount bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_period text;
  v_limit bigint;
  v_used bigint;
begin
  foreach v_period in array array['day', 'week', 'month'] loop
    v_limit := public.current_limit(p_user, p_kind, v_period);
    if v_limit is not null then
      v_used := public.limit_usage(p_user, p_kind, public.period_start(v_period));
      if v_used + p_amount > v_limit then
        raise exception 'limit_exceeded:%:%:%', p_kind, v_period, greatest(v_limit - v_used, 0) using errcode = 'P0001';
      end if;
    end if;
  end loop;
end $$;

create function public.set_limit(p_user uuid, p_kind text, p_period text, p_amount_cents bigint, p_actor text)
returns public.player_limits
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_current bigint := public.current_limit(p_user, p_kind, p_period);
  v_stricter boolean;
  v_row public.player_limits;
begin
  v_stricter := p_amount_cents is not null and (v_current is null or p_amount_cents < v_current);
  insert into public.player_limits (user_id, kind, period, amount_cents, effective_at, created_by)
    values (p_user, p_kind, p_period, p_amount_cents,
            case when v_stricter then now() else now() + interval '24 hours' end, p_actor)
    returning * into v_row;
  return v_row;
end $$;

-- ---------- cool-off and self-exclusion ---------------------------------------
create table public.player_exclusions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  kind text not null check (kind in ('cool_off', 'self_exclusion')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,           -- 'infinity' = permanent
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on public.player_exclusions (user_id, created_at desc);
create trigger player_exclusions_append_only before update or delete on public.player_exclusions
  for each row execute function public.forbid_mutation();

create function public.set_exclusion(p_user uuid, p_kind text, p_days int, p_actor text) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_until timestamptz;
begin
  if p_kind = 'cool_off' and (p_days is null or p_days not in (1, 7, 30)) then
    raise exception 'invalid_cool_off' using errcode = 'P0001';
  end if;
  if p_kind = 'self_exclusion' and p_days is not null and p_days not in (180, 365, 1825) then
    raise exception 'invalid_self_exclusion' using errcode = 'P0001';
  end if;
  if p_kind not in ('cool_off', 'self_exclusion') then raise exception 'invalid_exclusion' using errcode = 'P0001'; end if;
  v_until := case when p_days is null then 'infinity'::timestamptz else now() + make_interval(days => p_days) end;
  insert into public.player_exclusions (user_id, kind, ends_at, created_by) values (p_user, p_kind, v_until, p_actor);
  -- Extend only: an exclusion can never be shortened.
  update public.profiles
     set self_exclusion_until = greatest(coalesce(self_exclusion_until, now()), v_until)
   where id = p_user
   returning self_exclusion_until into v_until;
  return v_until;
end $$;

-- Exclusions may only move later.
create function public.profiles_exclusion_guard() returns trigger
language plpgsql as $$
begin
  if old.self_exclusion_until is not null and old.self_exclusion_until > now()
     and (new.self_exclusion_until is null or new.self_exclusion_until < old.self_exclusion_until) then
    raise exception 'self_exclusion_cannot_be_shortened' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger profiles_exclusion_guard before update of self_exclusion_until on public.profiles
  for each row execute function public.profiles_exclusion_guard();

-- ---------- spend summary -------------------------------------------------------
create function public.spend_summary(p_user uuid)
returns table (period text, deposits_cents bigint, withdrawals_cents bigint, staked_cents bigint, returned_cents bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with periods(period, since) as (
    values ('day', public.period_start('day')), ('week', public.period_start('week')),
           ('month', public.period_start('month')), ('all', '-infinity'::timestamptz))
  select p.period,
    (select coalesce(sum(amount_cents), 0) from public.payments where user_id = p_user and direction = 'deposit' and status = 'succeeded' and created_at >= p.since)::bigint,
    (select coalesce(sum(amount_cents), 0) from public.payments where user_id = p_user and direction = 'withdrawal' and status = 'paid' and created_at >= p.since)::bigint,
    (select coalesce(sum(stake_cents), 0) from public.entries where user_id = p_user and created_at >= p.since)::bigint,
    (select coalesce(sum(payout_cents), 0) from public.entries where user_id = p_user and settled_at >= p.since)::bigint
  from periods p
$$;

-- ---------- limits enforced where money moves ---------------------------------------
create or replace function public.start_deposit(p_user uuid, p_amount_cents bigint, p_provider text, p_key text, p_geo bigint)
returns public.payments
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pay public.payments;
  v_p public.profiles;
begin
  select * into v_pay from public.payments where user_id = p_user and idempotency_key = p_key;
  if found then return v_pay; end if;
  if p_amount_cents is null or p_amount_cents < 1000 then raise exception 'deposit_below_minimum' using errcode = 'P0001'; end if;
  if p_amount_cents > 250000 then raise exception 'deposit_above_maximum' using errcode = 'P0001'; end if;
  v_p := public.money_gate(p_user, p_geo, 'deposit');
  if v_p.self_exclusion_until is not null and v_p.self_exclusion_until > now() then
    raise exception 'self_excluded' using errcode = 'P0001';
  end if;
  perform public.enforce_limits(p_user, 'deposit', p_amount_cents);
  insert into public.payments (user_id, direction, amount_cents, status, provider, idempotency_key, geo_check_id)
    values (p_user, 'deposit', p_amount_cents, 'created', p_provider, p_key, p_geo)
    returning * into v_pay;
  return v_pay;
end $$;

create or replace function public.place_entry(p_user uuid, p_picks jsonb, p_stake_cents bigint, p_key text, p_geo_check bigint)
returns public.entries
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_geo public.geo_checks;
  v_profile public.profiles;
  v_existing public.entries;
begin
  select * into v_existing from public.entries where user_id = p_user and idempotency_key = p_key;
  if found then return v_existing; end if;

  select * into v_geo from public.geo_checks where id = p_geo_check;
  if not found or v_geo.user_id <> p_user or v_geo.action <> 'entry' or v_geo.decision <> 'allow'
     or v_geo.created_at < now() - interval '2 minutes' then
    raise exception 'location_check_required' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.jurisdictions where state = v_geo.region and enabled) then
    raise exception 'location_not_eligible' using errcode = 'P0001';
  end if;

  select * into v_profile from public.profiles where id = p_user;
  if v_profile.dob is null then raise exception 'profile_required' using errcode = 'P0001'; end if;
  if date_part('year', age(current_date, v_profile.dob)) < public.min_age_for(v_profile.state, v_geo.region::char(2)) then
    raise exception 'under_age' using errcode = 'P0001';
  end if;
  if coalesce((v_profile.flags ->> 'blocked')::boolean, false) then
    raise exception 'account_blocked' using errcode = 'P0001';
  end if;
  if v_profile.self_exclusion_until is not null and v_profile.self_exclusion_until > now() then
    raise exception 'self_excluded' using errcode = 'P0001';
  end if;

  perform public.enforce_limits(p_user, 'stake', p_stake_cents);
  perform public.enforce_limits(p_user, 'loss', p_stake_cents);

  return public.place_entry_unchecked(p_user, p_picks, p_stake_cents, p_key);
end $$;

-- ---------- audit log -----------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  subject_user uuid,
  entity text,
  entity_id text,
  details jsonb not null default '{}'::jsonb
);
create index on public.audit_log (at desc);
create index on public.audit_log (subject_user, at desc);
create index on public.audit_log (action, at desc);
create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function public.forbid_mutation();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.forbid_mutation();

create function public.audit_actor() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('app.actor', true), ''), 'system:' || current_user)
$$;

-- Explicit entries (operator actions, player settings) with a named actor.
create function public.log_audit(p_actor text, p_action text, p_subject uuid, p_entity text, p_entity_id text, p_details jsonb)
returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_log (actor, action, subject_user, entity, entity_id, details)
  values (coalesce(p_actor, public.audit_actor()), p_action, p_subject, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb))
$$;

create function public.audit_capture() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_action text;
  v_subject uuid;
  v_details jsonb := '{}'::jsonb;
  v_id text;
begin
  case tg_table_name
    when 'ledger_transactions' then
      v_action := 'ledger.' || new.kind; v_subject := new.user_id; v_id := new.id::text;
      v_details := jsonb_build_object('key', new.idempotency_key, 'entry', new.entry_id, 'payment_ref', new.payment_ref, 'memo', new.memo,
        'amount_cents', (select sum(amount_cents) filter (where amount_cents > 0) from public.ledger_postings where txn_id = new.id));
    when 'payments' then
      if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
      v_action := 'payment.' || new.direction || '.' || new.status; v_subject := new.user_id; v_id := new.id::text;
      v_details := jsonb_build_object('amount_cents', new.amount_cents, 'provider', new.provider, 'ref', new.provider_ref,
        'from', case when tg_op = 'UPDATE' then old.status end, 'reason', new.failure_reason, 'reviewed_by', new.reviewed_by);
    when 'kyc_records' then
      if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
      v_action := 'kyc.' || new.status; v_subject := new.user_id; v_id := new.id::text;
      v_details := jsonb_build_object('provider', new.provider, 'reason', new.reason, 'decided_by', new.decided_by);
    when 'player_limits' then
      v_action := 'limit.set'; v_subject := new.user_id; v_id := new.id::text;
      v_details := jsonb_build_object('kind', new.kind, 'period', new.period, 'amount_cents', new.amount_cents, 'effective_at', new.effective_at, 'by', new.created_by);
    when 'player_exclusions' then
      v_action := 'exclusion.' || new.kind; v_subject := new.user_id; v_id := new.id::text;
      v_details := jsonb_build_object('ends_at', new.ends_at, 'by', new.created_by);
    when 'jurisdictions' then
      if new.enabled is not distinct from old.enabled and new.min_age is not distinct from old.min_age then return new; end if;
      v_action := 'jurisdiction.update'; v_id := new.state;
      v_details := jsonb_build_object('enabled', new.enabled, 'was_enabled', old.enabled, 'min_age', new.min_age, 'was_min_age', old.min_age, 'by', new.updated_by);
    when 'profiles' then
      if new.flags is not distinct from old.flags and new.kyc_status is not distinct from old.kyc_status
         and new.self_exclusion_until is not distinct from old.self_exclusion_until and new.dob is not distinct from old.dob
         and new.state is not distinct from old.state then return new; end if;
      v_action := 'profile.update'; v_subject := new.id; v_id := new.id::text;
      v_details := jsonb_strip_nulls(jsonb_build_object(
        'flags', case when new.flags is distinct from old.flags then jsonb_build_object('from', old.flags, 'to', new.flags) end,
        'kyc_status', case when new.kyc_status is distinct from old.kyc_status then jsonb_build_object('from', old.kyc_status, 'to', new.kyc_status) end,
        'self_exclusion_until', case when new.self_exclusion_until is distinct from old.self_exclusion_until then jsonb_build_object('from', old.self_exclusion_until, 'to', new.self_exclusion_until) end,
        'dob_changed', case when new.dob is distinct from old.dob and old.dob is not null then true end,
        'state', case when new.state is distinct from old.state then jsonb_build_object('from', old.state, 'to', new.state) end));
    when 'projections' then
      if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.line is not distinct from old.line
         and new.result is not distinct from old.result then return new; end if;
      v_action := case when tg_op = 'INSERT' then 'line.created' when new.result is distinct from old.result then 'line.graded'
                       when new.status is distinct from old.status then 'line.' || new.status else 'line.changed' end;
      v_id := new.id::text;
      v_details := jsonb_build_object('player', new.player_name, 'stat', new.stat_type, 'line', new.line, 'status', new.status, 'result', new.result,
        'old_line', case when tg_op = 'UPDATE' then old.line end);
    when 'games' then
      if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.starts_at is not distinct from old.starts_at then return new; end if;
      v_action := case when tg_op = 'INSERT' then 'game.created' else 'game.' || new.status end; v_id := new.id::text;
      v_details := jsonb_build_object('sport', new.sport, 'away', new.away_team, 'home', new.home_team, 'starts_at', new.starts_at);
    when 'geo_checks' then
      if new.decision <> 'deny' then return new; end if;   -- every check is already in geo_checks; denials are copied here
      v_action := 'geo.deny'; v_subject := new.user_id; v_id := new.id::text;
      v_details := jsonb_build_object('action', new.action, 'region', new.region, 'country', new.country, 'reason', new.reason);
    else return new;
  end case;
  insert into public.audit_log (actor, action, subject_user, entity, entity_id, details)
    values (public.audit_actor(), v_action, v_subject, tg_table_name, v_id, v_details);
  return new;
end $$;

-- Deferred to commit so the transaction's postings exist when the amount is recorded.
create constraint trigger audit_ledger after insert on public.ledger_transactions deferrable initially deferred
  for each row execute function public.audit_capture();
create trigger audit_payments after insert or update on public.payments for each row execute function public.audit_capture();
create trigger audit_kyc after insert or update on public.kyc_records for each row execute function public.audit_capture();
create trigger audit_limits after insert on public.player_limits for each row execute function public.audit_capture();
create trigger audit_exclusions after insert on public.player_exclusions for each row execute function public.audit_capture();
create trigger audit_jurisdictions after update on public.jurisdictions for each row execute function public.audit_capture();
create trigger audit_profiles after update on public.profiles for each row execute function public.audit_capture();
create trigger audit_projections after insert or update on public.projections for each row execute function public.audit_capture();
create trigger audit_games after insert or update on public.games for each row execute function public.audit_capture();
create trigger audit_geo after insert on public.geo_checks for each row execute function public.audit_capture();

-- ---------- rate limiting -----------------------------------------------------------
create unlogged table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);

-- Returns true if the call is allowed (fewer than p_max hits in the current window).
create function public.hit_rate_limit(p_key text, p_max int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into public.rate_limits (key, window_start, hits) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set hits = rate_limits.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then delete from public.rate_limits where window_start < now() - interval '1 day'; end if;
  return v_hits <= p_max;
end $$;

-- ---------- access ----------------------------------------------------------------
alter table public.player_limits enable row level security;
alter table public.player_exclusions enable row level security;
alter table public.audit_log enable row level security;
alter table public.rate_limits enable row level security;

create policy "own limits" on public.player_limits for select to authenticated using (user_id = auth.uid());
create policy "own exclusions" on public.player_exclusions for select to authenticated using (user_id = auth.uid());

revoke all on public.player_limits, public.player_exclusions, public.audit_log, public.rate_limits from anon, authenticated;
grant select (id, kind, period, amount_cents, effective_at, created_at) on public.player_limits to authenticated;
grant select (id, kind, starts_at, ends_at, created_at) on public.player_exclusions to authenticated;

revoke execute on function public.current_limit(uuid, text, text), public.limit_usage(uuid, text, timestamptz),
  public.enforce_limits(uuid, text, bigint), public.set_limit(uuid, text, text, bigint, text),
  public.set_exclusion(uuid, text, int, text), public.spend_summary(uuid), public.log_audit(text, text, uuid, text, text, jsonb),
  public.audit_capture(), public.hit_rate_limit(text, int, int), public.profiles_exclusion_guard(), public.audit_actor()
  from public, anon, authenticated;
grant execute on function public.current_limit(uuid, text, text), public.limit_usage(uuid, text, timestamptz),
  public.set_limit(uuid, text, text, bigint, text), public.set_exclusion(uuid, text, int, text), public.spend_summary(uuid),
  public.log_audit(text, text, uuid, text, text, jsonb), public.hit_rate_limit(text, int, int) to service_role;
grant all on public.player_limits, public.player_exclusions, public.audit_log, public.rate_limits to service_role;
