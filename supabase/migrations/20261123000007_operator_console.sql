-- =====================================================================
-- Phase 6: operator console helpers.
--   * force_settle_leg   — operator decides one pending leg of one entry (disputes,
--                          stat corrections for a single player), then the entry settles.
--   * fail_pending_deposit — mark an open checkout failed once the processor confirms
--                          it failed (no money moves; a later success webhook is refused).
--   * player_sessions    — the player's auth sessions (read-only, for the console).
-- Every action writes an audit row naming the operator.
-- =====================================================================

create function public.force_settle_leg(p_entry uuid, p_projection uuid, p_result text, p_reason text, p_by text)
returns public.entries
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pick public.entry_picks;
  v_e public.entries;
begin
  if p_result not in ('hit', 'miss', 'void') then raise exception 'invalid_result' using errcode = 'P0001'; end if;
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required' using errcode = 'P0001'; end if;
  select * into v_e from public.entries where id = p_entry for update;
  if not found then raise exception 'entry_not_found' using errcode = 'P0001'; end if;
  if v_e.status <> 'open' then raise exception 'entry_already_settled' using errcode = 'P0001'; end if;
  select * into v_pick from public.entry_picks where entry_id = p_entry and projection_id = p_projection for update;
  if not found then raise exception 'leg_not_found' using errcode = 'P0001'; end if;
  if v_pick.result <> 'pending' then raise exception 'leg_already_settled' using errcode = 'P0001'; end if;

  update public.entry_picks set result = p_result::public.leg_result where entry_id = p_entry and projection_id = p_projection;
  perform public.log_audit(p_by, 'operator.force_settle_leg', v_e.user_id, 'entries', p_entry::text,
    jsonb_build_object('projection', p_projection, 'result', p_result, 'reason', p_reason, 'line', v_pick.line, 'direction', v_pick.direction));
  return public.settle_entry(p_entry);
end $$;

create function public.fail_pending_deposit(p_payment uuid, p_reason text, p_by text) returns public.payments
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pay public.payments;
begin
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required' using errcode = 'P0001'; end if;
  select * into v_pay from public.payments where id = p_payment and direction = 'deposit' for update;
  if not found then raise exception 'payment_not_found' using errcode = 'P0001'; end if;
  if v_pay.status <> 'created' then raise exception 'deposit_not_pending' using errcode = 'P0001'; end if;
  update public.payments set status = 'failed', failure_reason = 'operator: ' || p_reason, reviewed_by = p_by, reviewed_at = now(), updated_at = now()
    where id = p_payment returning * into v_pay;
  return v_pay;
end $$;

-- Sessions from Supabase Auth, as JSON so column differences between Auth versions don't matter.
create function public.player_sessions(p_user uuid) returns setof jsonb
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select to_jsonb(s) - 'factor_id' from auth.sessions s where s.user_id = p_user order by s.created_at desc limit 20
$$;

revoke execute on function public.force_settle_leg(uuid, uuid, text, text, text), public.fail_pending_deposit(uuid, text, text),
  public.player_sessions(uuid) from public, anon, authenticated;
grant execute on function public.force_settle_leg(uuid, uuid, text, text, text), public.fail_pending_deposit(uuid, text, text),
  public.player_sessions(uuid) to service_role;
