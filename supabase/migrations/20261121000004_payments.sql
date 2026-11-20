-- =====================================================================
-- Phase 4: deposits, withdrawals, webhooks and reconciliation.
--
--   * payments          — one row per deposit/withdrawal with a strict status flow.
--   * payment_methods   — provider tokens only (never card or account numbers).
--   * payment_events    — append-only log of every verified provider webhook;
--                         the unique (provider, event_id) makes processing exactly-once.
--   * provider_settlements — the processor's settlement report, imported for reconciliation.
--
-- Money only moves in these functions, and only from verified provider events:
--   deposit:   created --(deposit.succeeded webhook, amount must match)--> succeeded  [+cash]
--              created --(deposit.failed)--> failed
--              succeeded --(deposit.reversed / chargeback)--> reversed [claw back, freeze account]
--   withdrawal: requested [cash -> hold] --operator--> approved --(payout.paid)--> paid [hold -> clearing]
--              requested --player--> cancelled [hold -> cash]
--              requested --operator--> rejected [hold -> cash]
--              approved --(payout.failed)--> failed [hold -> cash]
-- =====================================================================

alter type public.txn_kind add value if not exists 'chargeback';

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  provider text not null,
  provider_token text not null,
  kind text not null check (kind in ('card', 'bank', 'wallet')),
  label text not null,                    -- e.g. "Visa •••• 4242"
  holder_name_hash text,                  -- hash of the account holder name reported by the provider
  status text not null default 'active' check (status in ('active', 'removed', 'blocked')),
  created_at timestamptz not null default now(),
  unique (provider, provider_token)
);
create index on public.payment_methods (user_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  direction text not null check (direction in ('deposit', 'withdrawal')),
  amount_cents bigint not null check (amount_cents > 0),
  currency char(3) not null default 'USD',
  status text not null,
  provider text not null,
  provider_ref text,
  method_id uuid references public.payment_methods (id),
  idempotency_key text not null,
  failure_reason text,
  geo_check_id bigint references public.geo_checks (id),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  unique (provider, provider_ref),
  check (
    (direction = 'deposit' and status in ('created', 'succeeded', 'failed', 'reversed')) or
    (direction = 'withdrawal' and status in ('requested', 'approved', 'paid', 'rejected', 'failed', 'cancelled'))
  )
);
create index on public.payments (user_id, created_at desc);
create index on public.payments (status) where status in ('created', 'requested', 'approved');

create table public.payment_events (
  id bigint generated always as identity primary key,
  provider text not null,
  event_id text not null,
  type text not null,
  provider_ref text,
  amount_cents bigint,
  payload jsonb,
  result text not null,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);
create trigger payment_events_append_only before update or delete on public.payment_events
  for each row execute function public.forbid_mutation();
create trigger payment_events_no_truncate before truncate on public.payment_events
  for each statement execute function public.forbid_mutation();
create trigger geo_checks_no_truncate before truncate on public.geo_checks
  for each statement execute function public.forbid_mutation();

create table public.provider_settlements (
  id bigint generated always as identity primary key,
  provider text not null,
  provider_ref text not null,
  direction text not null check (direction in ('deposit', 'withdrawal')),
  amount_cents bigint not null,
  settled_at timestamptz,
  imported_at timestamptz not null default now(),
  imported_by text,
  unique (provider, provider_ref, direction)
);

-- ---------- shared checks --------------------------------------------------
-- Validates the fresh location check for a money action and returns the player's profile.
create function public.money_gate(p_user uuid, p_geo bigint, p_action text) returns public.profiles
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_geo public.geo_checks;
  v_p public.profiles;
begin
  select * into v_geo from public.geo_checks where id = p_geo;
  if not found or v_geo.user_id <> p_user or v_geo.action <> p_action or v_geo.decision <> 'allow'
     or v_geo.created_at < now() - interval '2 minutes' then
    raise exception 'location_check_required' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.jurisdictions where state = v_geo.region and enabled) then
    raise exception 'location_not_eligible' using errcode = 'P0001';
  end if;
  select * into v_p from public.profiles where id = p_user;
  if v_p.dob is null then raise exception 'profile_required' using errcode = 'P0001'; end if;
  if date_part('year', age(current_date, v_p.dob)) < public.min_age_for(v_p.state, v_geo.region::char(2)) then
    raise exception 'under_age' using errcode = 'P0001';
  end if;
  if coalesce((v_p.flags ->> 'blocked')::boolean, false) then raise exception 'account_blocked' using errcode = 'P0001'; end if;
  return v_p;
end $$;

-- ---------- deposits ----------------------------------------------------------
create function public.start_deposit(p_user uuid, p_amount_cents bigint, p_provider text, p_key text, p_geo bigint)
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
  insert into public.payments (user_id, direction, amount_cents, status, provider, idempotency_key, geo_check_id)
    values (p_user, 'deposit', p_amount_cents, 'created', p_provider, p_key, p_geo)
    returning * into v_pay;
  return v_pay;
end $$;

create function public.set_payment_ref(p_payment uuid, p_ref text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.payments set provider_ref = p_ref, updated_at = now() where id = p_payment and provider_ref is null
$$;

-- ---------- withdrawals ------------------------------------------------------
create function public.request_withdrawal(p_user uuid, p_amount_cents bigint, p_method uuid, p_key text, p_geo bigint)
returns public.payments
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pay public.payments;
  v_p public.profiles;
  v_m public.payment_methods;
begin
  select * into v_pay from public.payments where user_id = p_user and idempotency_key = p_key;
  if found then return v_pay; end if;
  if p_amount_cents is null or p_amount_cents < 1000 then raise exception 'withdrawal_below_minimum' using errcode = 'P0001'; end if;
  v_p := public.money_gate(p_user, p_geo, 'withdrawal');
  if v_p.kyc_status <> 'approved' then raise exception 'kyc_required' using errcode = 'P0001'; end if;

  select * into v_m from public.payment_methods where id = p_method and user_id = p_user and status = 'active';
  if not found then raise exception 'method_not_found' using errcode = 'P0001'; end if;
  -- Closed loop: money only goes back to a method this player has successfully deposited with.
  if not exists (select 1 from public.payments where method_id = v_m.id and direction = 'deposit' and status = 'succeeded') then
    raise exception 'method_not_verified' using errcode = 'P0001';
  end if;

  insert into public.payments (user_id, direction, amount_cents, status, provider, method_id, idempotency_key, geo_check_id)
    values (p_user, 'withdrawal', p_amount_cents, 'requested', v_m.provider, v_m.id, p_key, p_geo)
    returning * into v_pay;
  -- Fails with insufficient_funds (rolling everything back) if the player can't cover it.
  perform public.ledger_post('withdrawal_hold', 'withdrawal:hold:' || v_pay.id, jsonb_build_array(
      jsonb_build_object('account', public.ledger_account('user_cash', p_user), 'amount', -p_amount_cents),
      jsonb_build_object('account', public.ledger_account('user_withdrawal_hold', p_user), 'amount', p_amount_cents)),
    p_user, null, null, 'withdrawal requested');
  return v_pay;
end $$;

create function public.release_withdrawal(v_pay public.payments, p_status text, p_reason text, p_by text)
returns public.payments
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_out public.payments;
begin
  perform public.ledger_post('withdrawal_released', 'withdrawal:release:' || v_pay.id, jsonb_build_array(
      jsonb_build_object('account', public.ledger_account('user_withdrawal_hold', v_pay.user_id), 'amount', -v_pay.amount_cents),
      jsonb_build_object('account', public.ledger_account('user_cash', v_pay.user_id), 'amount', v_pay.amount_cents)),
    v_pay.user_id, null, v_pay.provider_ref, format('withdrawal %s', p_status));
  update public.payments set status = p_status, failure_reason = p_reason, reviewed_by = coalesce(p_by, reviewed_by),
      reviewed_at = case when p_by is not null then now() else reviewed_at end, updated_at = now()
    where id = v_pay.id returning * into v_out;
  return v_out;
end $$;

create function public.cancel_withdrawal(p_user uuid, p_payment uuid) returns public.payments
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pay public.payments;
begin
  select * into v_pay from public.payments where id = p_payment and user_id = p_user and direction = 'withdrawal' for update;
  if not found then raise exception 'payment_not_found' using errcode = 'P0001'; end if;
  if v_pay.status <> 'requested' then raise exception 'withdrawal_not_cancellable' using errcode = 'P0001'; end if;
  return public.release_withdrawal(v_pay, 'cancelled', 'cancelled by player', null);
end $$;

create function public.review_withdrawal(p_payment uuid, p_approve boolean, p_reason text, p_by text) returns public.payments
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pay public.payments;
  v_p public.profiles;
begin
  select * into v_pay from public.payments where id = p_payment and direction = 'withdrawal' for update;
  if not found then raise exception 'payment_not_found' using errcode = 'P0001'; end if;
  if v_pay.status <> 'requested' then raise exception 'withdrawal_already_reviewed' using errcode = 'P0001'; end if;
  if not p_approve then
    if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required' using errcode = 'P0001'; end if;
    return public.release_withdrawal(v_pay, 'rejected', p_reason, p_by);
  end if;
  select * into v_p from public.profiles where id = v_pay.user_id;
  if v_p.kyc_status <> 'approved' then raise exception 'kyc_required' using errcode = 'P0001'; end if;
  if coalesce((v_p.flags ->> 'blocked')::boolean, false) then raise exception 'account_blocked' using errcode = 'P0001'; end if;
  update public.payments set status = 'approved', reviewed_by = p_by, reviewed_at = now(), updated_at = now()
    where id = v_pay.id returning * into v_pay;
  return v_pay;
end $$;

-- ---------- provider events (exactly-once) ---------------------------------
-- Called only after the server has verified the provider's webhook signature.
-- Duplicate event ids return 'duplicate' and change nothing; concurrent duplicates
-- collide on the unique key and roll back.
create function public.process_payment_event(
  p_provider text, p_event_id text, p_type text, p_ref text, p_amount_cents bigint, p_payload jsonb,
  p_method_token text default null, p_method_kind text default null, p_method_label text default null,
  p_holder_hash text default null, p_reason text default null
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pay public.payments;
  v_result text;
  v_method uuid;
  v_available bigint;
  v_claw bigint;
begin
  if exists (select 1 from public.payment_events where provider = p_provider and event_id = p_event_id) then
    return 'duplicate';
  end if;

  select * into v_pay from public.payments where provider = p_provider and provider_ref = p_ref for update;
  if not found then
    v_result := 'unknown_payment';
  elsif p_type = 'deposit.succeeded' then
    if v_pay.direction <> 'deposit' then v_result := 'wrong_direction';
    elsif v_pay.status = 'succeeded' then v_result := 'already_applied';
    elsif v_pay.status <> 'created' then v_result := 'invalid_state:' || v_pay.status;
    elsif p_amount_cents is distinct from v_pay.amount_cents then
      update public.payments set status = 'failed', failure_reason = format('amount_mismatch: expected %s, provider reported %s', v_pay.amount_cents, p_amount_cents), updated_at = now()
        where id = v_pay.id;
      v_result := 'amount_mismatch';
    else
      if p_method_token is not null then
        insert into public.payment_methods (user_id, provider, provider_token, kind, label, holder_name_hash)
          values (v_pay.user_id, p_provider, p_method_token, coalesce(p_method_kind, 'card'), coalesce(p_method_label, 'Payment method'), p_holder_hash)
        on conflict (provider, provider_token) do update set label = excluded.label
        returning id into v_method;
        if (select user_id from public.payment_methods where id = v_method) <> v_pay.user_id then
          raise exception 'payment_method_belongs_to_another_account' using errcode = 'P0001';
        end if;
      end if;
      perform public.credit_deposit(v_pay.user_id, v_pay.amount_cents, p_ref, 'deposit:' || v_pay.id);
      update public.payments set status = 'succeeded', method_id = coalesce(v_method, method_id), updated_at = now() where id = v_pay.id;
      v_result := 'credited';
    end if;
  elsif p_type = 'deposit.failed' then
    if v_pay.status = 'created' then
      update public.payments set status = 'failed', failure_reason = coalesce(p_reason, 'declined'), updated_at = now() where id = v_pay.id;
      v_result := 'failed';
    else v_result := 'ignored:' || v_pay.status; end if;
  elsif p_type = 'deposit.reversed' then
    if v_pay.status <> 'succeeded' then v_result := 'ignored:' || v_pay.status;
    else
      -- Chargeback: freeze the account and claw back whatever cash is unspent.
      select coalesce(b.balance_cents, 0) into v_available
        from public.ledger_accounts a left join public.ledger_balances b on b.account_id = a.id
       where a.user_id = v_pay.user_id and a.kind = 'user_cash';
      v_claw := least(coalesce(v_available, 0), v_pay.amount_cents);
      if v_claw > 0 then
        perform public.ledger_post('chargeback', 'chargeback:' || v_pay.id, jsonb_build_array(
            jsonb_build_object('account', public.ledger_account('user_cash', v_pay.user_id), 'amount', -v_claw),
            jsonb_build_object('account', public.ledger_account('house_payment_clearing'), 'amount', v_claw)),
          v_pay.user_id, null, p_ref, 'chargeback claw-back');
      end if;
      update public.payments set status = 'reversed',
          failure_reason = format('chargeback: clawed back %s of %s cents; shortfall %s', v_claw, v_pay.amount_cents, v_pay.amount_cents - v_claw),
          updated_at = now() where id = v_pay.id;
      update public.profiles set flags = flags || jsonb_build_object('blocked', true, 'chargeback', true) where id = v_pay.user_id;
      update public.payment_methods set status = 'blocked' where id = v_pay.method_id;
      v_result := 'reversed';
    end if;
  elsif p_type = 'payout.paid' then
    if v_pay.direction <> 'withdrawal' then v_result := 'wrong_direction';
    elsif v_pay.status = 'paid' then v_result := 'already_applied';
    elsif v_pay.status <> 'approved' then v_result := 'invalid_state:' || v_pay.status;
    elsif p_amount_cents is distinct from v_pay.amount_cents then v_result := 'amount_mismatch';
    else
      perform public.ledger_post('withdrawal_paid', 'withdrawal:paid:' || v_pay.id, jsonb_build_array(
          jsonb_build_object('account', public.ledger_account('user_withdrawal_hold', v_pay.user_id), 'amount', -v_pay.amount_cents),
          jsonb_build_object('account', public.ledger_account('house_payment_clearing'), 'amount', v_pay.amount_cents)),
        v_pay.user_id, null, p_ref, 'withdrawal paid out');
      update public.payments set status = 'paid', updated_at = now() where id = v_pay.id;
      v_result := 'paid';
    end if;
  elsif p_type = 'payout.failed' then
    if v_pay.status = 'approved' then
      perform public.release_withdrawal(v_pay, 'failed', coalesce(p_reason, 'payout failed'), null);
      v_result := 'released';
    else v_result := 'ignored:' || v_pay.status; end if;
  else
    v_result := 'unsupported_type';
  end if;

  insert into public.payment_events (provider, event_id, type, provider_ref, amount_cents, payload, result)
    values (p_provider, p_event_id, p_type, p_ref, p_amount_cents, p_payload, v_result);
  return v_result;
end $$;

-- ---------- reconciliation ------------------------------------------------------
-- Compares the processor's settlement report, our payments and the ledger.
-- Empty result = everything matches.
create function public.reconcile_payments()
returns table (issue text, payment_id uuid, provider text, provider_ref text, ours_cents bigint, theirs_cents bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  -- Settled at the provider, but not completed on our side (or unknown to us)
  select 'missing_internally', p.id, s.provider, s.provider_ref, p.amount_cents, s.amount_cents
    from public.provider_settlements s
    left join public.payments p on p.provider = s.provider and p.provider_ref = s.provider_ref and p.direction = s.direction
   where p.id is null or p.status not in ('succeeded', 'paid', 'reversed')
  union all
  -- Amounts disagree
  select 'amount_mismatch', p.id, s.provider, s.provider_ref, p.amount_cents, s.amount_cents
    from public.provider_settlements s
    join public.payments p on p.provider = s.provider and p.provider_ref = s.provider_ref and p.direction = s.direction
   where p.amount_cents <> s.amount_cents
  union all
  -- Completed on our side but absent from the provider's report (only once a report has been imported)
  select 'missing_at_provider', p.id, p.provider, p.provider_ref, p.amount_cents, null
    from public.payments p
   where p.status in ('succeeded', 'paid')
     and exists (select 1 from public.provider_settlements s0 where s0.provider = p.provider)
     and not exists (select 1 from public.provider_settlements s where s.provider = p.provider and s.provider_ref = p.provider_ref and s.direction = p.direction)
  union all
  -- Completed payments whose ledger transaction is missing
  select 'ledger_missing', p.id, p.provider, p.provider_ref, p.amount_cents, null
    from public.payments p
   where (p.direction = 'deposit' and p.status in ('succeeded', 'reversed')
          and not exists (select 1 from public.ledger_transactions t where t.idempotency_key = 'deposit:' || p.id))
      or (p.direction = 'withdrawal' and p.status = 'paid'
          and not exists (select 1 from public.ledger_transactions t where t.idempotency_key = 'withdrawal:paid:' || p.id))
$$;

-- ---------- access ----------------------------------------------------------
alter table public.payment_methods enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
alter table public.provider_settlements enable row level security;

create policy "own payments" on public.payments for select to authenticated using (user_id = auth.uid());
create policy "own payment methods" on public.payment_methods for select to authenticated using (user_id = auth.uid());

revoke all on public.payment_methods, public.payments, public.payment_events, public.provider_settlements from anon, authenticated;
grant select (id, direction, amount_cents, currency, status, method_id, failure_reason, created_at, updated_at) on public.payments to authenticated;
grant select (id, kind, label, status, created_at) on public.payment_methods to authenticated;

revoke execute on function public.money_gate(uuid, bigint, text), public.start_deposit(uuid, bigint, text, text, bigint),
  public.set_payment_ref(uuid, text), public.request_withdrawal(uuid, bigint, uuid, text, bigint),
  public.release_withdrawal(public.payments, text, text, text), public.cancel_withdrawal(uuid, uuid),
  public.review_withdrawal(uuid, boolean, text, text),
  public.process_payment_event(text, text, text, text, bigint, jsonb, text, text, text, text, text),
  public.reconcile_payments() from public, anon, authenticated;
grant execute on function public.start_deposit(uuid, bigint, text, text, bigint), public.set_payment_ref(uuid, text),
  public.request_withdrawal(uuid, bigint, uuid, text, bigint), public.cancel_withdrawal(uuid, uuid),
  public.review_withdrawal(uuid, boolean, text, text),
  public.process_payment_event(text, text, text, text, bigint, jsonb, text, text, text, text, text),
  public.reconcile_payments() to service_role;
-- money_gate and release_withdrawal are internal helpers (called by the functions above only).
grant all on public.payment_methods, public.payments, public.payment_events, public.provider_settlements to service_role;
