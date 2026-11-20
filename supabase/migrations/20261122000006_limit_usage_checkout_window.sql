-- Deposit-limit usage: a checkout that's still open counts for one hour only, so an abandoned
-- checkout can't block a player for the whole limit window. Charged-back deposits still count
-- (the money was deposited). Stake and loss usage are unchanged.
create or replace function public.limit_usage(p_user uuid, p_kind text, p_since timestamptz) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_kind
    when 'deposit' then (select coalesce(sum(amount_cents), 0) from public.payments
                          where user_id = p_user and direction = 'deposit' and created_at >= p_since
                            and (status in ('succeeded', 'reversed') or (status = 'created' and created_at > now() - interval '1 hour')))
    when 'stake' then (select coalesce(sum(stake_cents), 0) from public.entries where user_id = p_user and created_at >= p_since)
    else greatest(0,
           (select coalesce(sum(stake_cents), 0) from public.entries where user_id = p_user and created_at >= p_since)
         - (select coalesce(sum(payout_cents), 0) from public.entries where user_id = p_user and settled_at >= p_since))
  end::bigint
$$;
