-- =====================================================================
-- PicksArena — phase 1 & 2: ledger integrity, entries, lock-at-start,
-- grading and automatic settlement.
--
-- Principles
--   * Every cent lives in an append-only, double-entry ledger. A
--     transaction's postings always sum to zero; rows are never updated
--     or deleted. Balances are a cache of the postings, reconciled by
--     ledger_reconcile().
--   * Player cash accounts can never go negative (enforced on insert).
--   * All money math runs here. The client only says "these picks, this
--     stake". Multipliers, payouts, lock times and push re-pricing are
--     computed server-side.
--   * Write functions are SECURITY DEFINER and executable only by
--     service_role (called from authenticated server endpoints that add
--     geo/KYC checks). Players can read only their own rows (RLS).
-- =====================================================================

-- ---------- types --------------------------------------------------------
create type public.sport as enum ('NBA', 'NFL');
create type public.game_status as enum ('scheduled', 'in_progress', 'final', 'void');
create type public.projection_status as enum ('open', 'pulled', 'final', 'void');
create type public.pick_direction as enum ('more', 'less');
create type public.leg_result as enum ('pending', 'hit', 'miss', 'push', 'void');
create type public.entry_status as enum ('open', 'won', 'lost', 'refunded');
create type public.account_kind as enum (
  'user_cash',              -- player's available balance
  'user_withdrawal_hold',   -- requested withdrawals awaiting payout
  'house_entry_escrow',     -- stakes of open entries
  'house_gaming',           -- house P&L from settled entries
  'house_payment_clearing', -- money in transit with the payment provider
  'house_adjustments'       -- operator corrections
);
create type public.txn_kind as enum (
  'deposit', 'withdrawal_hold', 'withdrawal_paid', 'withdrawal_released',
  'stake', 'payout', 'loss', 'refund', 'adjustment'
);

-- ---------- profiles -----------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  dob date,
  kyc_status text not null default 'none' check (kyc_status in ('none', 'pending', 'approved', 'rejected')),
  jurisdiction text,
  self_exclusion_until timestamptz,
  flags jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------- ledger -------------------------------------------------------
create table public.ledger_accounts (
  id bigint generated always as identity primary key,
  kind public.account_kind not null,
  user_id uuid references auth.users (id) on delete restrict,
  currency char(3) not null default 'USD',
  allow_negative boolean not null,
  created_at timestamptz not null default now(),
  constraint ledger_accounts_owner check ((kind::text like 'user\_%') = (user_id is not null)),
  constraint ledger_accounts_unique unique nulls not distinct (kind, user_id, currency)
);

create table public.ledger_balances (
  account_id bigint primary key references public.ledger_accounts (id),
  balance_cents bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table public.ledger_transactions (
  id bigint generated always as identity primary key,
  kind public.txn_kind not null,
  idempotency_key text not null unique,
  user_id uuid references auth.users (id),
  entry_id uuid,
  payment_ref text,
  memo text,
  created_by text not null default current_user,
  created_at timestamptz not null default now()
);

create table public.ledger_postings (
  id bigint generated always as identity primary key,
  txn_id bigint not null references public.ledger_transactions (id),
  account_id bigint not null references public.ledger_accounts (id),
  amount_cents bigint not null check (amount_cents <> 0),
  created_at timestamptz not null default now()
);
create index on public.ledger_postings (account_id);
create index on public.ledger_postings (txn_id);
create index on public.ledger_transactions (user_id, created_at desc);

-- Append-only: no updates, deletes or truncates on ledger rows.
create function public.ledger_forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger is append-only (% on %)', tg_op, tg_table_name using errcode = 'P0001';
end $$;

create trigger ledger_transactions_append_only before update or delete on public.ledger_transactions
  for each row execute function public.ledger_forbid_mutation();
create trigger ledger_postings_append_only before update or delete on public.ledger_postings
  for each row execute function public.ledger_forbid_mutation();
create trigger ledger_transactions_no_truncate before truncate on public.ledger_transactions
  for each statement execute function public.ledger_forbid_mutation();
create trigger ledger_postings_no_truncate before truncate on public.ledger_postings
  for each statement execute function public.ledger_forbid_mutation();

-- Each posting updates the cached balance; non-negative accounts can't overdraw.
create function public.ledger_apply_posting() returns trigger
language plpgsql as $$
declare
  v_balance bigint;
  v_allow_negative boolean;
begin
  insert into public.ledger_balances (account_id, balance_cents)
    values (new.account_id, new.amount_cents)
  on conflict (account_id) do update
    set balance_cents = ledger_balances.balance_cents + excluded.balance_cents,
        updated_at = now()
  returning balance_cents into v_balance;

  select allow_negative into v_allow_negative from public.ledger_accounts where id = new.account_id;
  if not v_allow_negative and v_balance < 0 then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger ledger_postings_apply after insert on public.ledger_postings
  for each row execute function public.ledger_apply_posting();

-- Every transaction must balance to zero with at least two postings (checked at commit).
create function public.ledger_check_balanced() returns trigger
language plpgsql as $$
declare
  v_sum bigint;
  v_count int;
begin
  select coalesce(sum(amount_cents), 0), count(*) into v_sum, v_count
    from public.ledger_postings where txn_id = new.txn_id;
  if v_sum <> 0 or v_count < 2 then
    raise exception 'unbalanced ledger transaction % (sum %, postings %)', new.txn_id, v_sum, v_count
      using errcode = 'P0001';
  end if;
  return null;
end $$;

create constraint trigger ledger_postings_balanced after insert on public.ledger_postings
  deferrable initially deferred
  for each row execute function public.ledger_check_balanced();

-- Get (or create) an account.
create function public.ledger_account(p_kind public.account_kind, p_user uuid default null)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id bigint;
begin
  select id into v_id from public.ledger_accounts
    where kind = p_kind and user_id is not distinct from p_user and currency = 'USD';
  if v_id is null then
    insert into public.ledger_accounts (kind, user_id, allow_negative)
      values (p_kind, p_user, p_kind::text like 'house\_%')
    on conflict on constraint ledger_accounts_unique do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.ledger_accounts
        where kind = p_kind and user_id is not distinct from p_user and currency = 'USD';
    end if;
  end if;
  return v_id;
end $$;

-- Post a balanced transaction. Idempotent on p_key: a repeat returns the
-- existing transaction id and writes nothing.
-- p_postings: [{"account": <id>, "amount": <cents>}, ...]
create function public.ledger_post(
  p_kind public.txn_kind,
  p_key text,
  p_postings jsonb,
  p_user uuid default null,
  p_entry uuid default null,
  p_payment_ref text default null,
  p_memo text default null
) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_txn bigint;
  v_post jsonb;
begin
  if p_key is null or length(p_key) < 8 then
    raise exception 'idempotency key required' using errcode = 'P0001';
  end if;

  insert into public.ledger_transactions (kind, idempotency_key, user_id, entry_id, payment_ref, memo)
    values (p_kind, p_key, p_user, p_entry, p_payment_ref, p_memo)
  on conflict (idempotency_key) do nothing
  returning id into v_txn;

  if v_txn is null then
    select id into v_txn from public.ledger_transactions where idempotency_key = p_key;
    return v_txn;
  end if;

  for v_post in select * from jsonb_array_elements(p_postings) loop
    if (v_post ->> 'amount')::bigint <> 0 then
      insert into public.ledger_postings (txn_id, account_id, amount_cents)
        values (v_txn, (v_post ->> 'account')::bigint, (v_post ->> 'amount')::bigint);
    end if;
  end loop;
  return v_txn;
end $$;

-- Integrity report: any cached balance that disagrees with its postings,
-- plus a global row if all postings don't sum to zero. Empty = healthy.
create function public.ledger_reconcile()
returns table (account_id bigint, cached_cents bigint, posted_cents bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.id, coalesce(b.balance_cents, 0), coalesce(p.total, 0)
    from public.ledger_accounts a
    left join public.ledger_balances b on b.account_id = a.id
    left join (select account_id, sum(amount_cents) as total from public.ledger_postings group by account_id) p
      on p.account_id = a.id
   where coalesce(b.balance_cents, 0) <> coalesce(p.total, 0)
  union all
  select null, 0, s.total
    from (select coalesce(sum(amount_cents), 0) as total from public.ledger_postings) s
   where s.total <> 0
$$;

-- ---------- slate --------------------------------------------------------
create table public.games (
  id uuid primary key default gen_random_uuid(),
  sport public.sport not null,
  home_team text not null,
  away_team text not null,
  starts_at timestamptz not null,
  status public.game_status not null default 'scheduled',
  home_score int,
  away_score int,
  external_id text unique,
  updated_at timestamptz not null default now(),
  check (home_team <> away_team)
);

create table public.projections (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id),
  slate_date date not null,
  player_id text not null,
  player_name text not null,
  team text not null,
  position text not null,
  stat_type text not null,
  line numeric(6, 1) not null check (line >= 0 and line * 2 = trunc(line * 2)),
  headshot_url text,
  status public.projection_status not null default 'open',
  current_value numeric(7, 1),
  result numeric(7, 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.projections (slate_date, status);
create index on public.projections (game_id);
create unique index projections_one_open_line
  on public.projections (game_id, player_id, stat_type) where status = 'open';

-- ---------- entries ------------------------------------------------------
create table public.entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  idempotency_key text not null,
  stake_cents bigint not null check (stake_cents > 0),
  pick_count smallint not null check (pick_count between 2 and 6),
  multiplier numeric(6, 2) not null,
  potential_payout_cents bigint not null,
  status public.entry_status not null default 'open',
  settled_legs smallint,
  settled_multiplier numeric(6, 2),
  payout_cents bigint not null default 0,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (user_id, idempotency_key)
);
create index on public.entries (user_id, created_at desc);
create index on public.entries (status) where status = 'open';

create table public.entry_picks (
  entry_id uuid not null references public.entries (id),
  projection_id uuid not null references public.projections (id),
  player_id text not null,
  team text not null,
  direction public.pick_direction not null,
  line numeric(6, 1) not null,          -- line at the moment the entry was placed
  result public.leg_result not null default 'pending',
  final_value numeric(7, 1),
  primary key (entry_id, projection_id),
  unique (entry_id, player_id)
);
create index on public.entry_picks (projection_id) where result = 'pending';

-- Player wallet: available cash, held (pending withdrawals) and stakes in play.
-- security_invoker: RLS on the underlying tables limits players to their own row.
create view public.wallets with (security_invoker = true) as
select a.user_id,
       coalesce(sum(b.balance_cents) filter (where a.kind = 'user_cash'), 0)::bigint as available_cents,
       coalesce(sum(b.balance_cents) filter (where a.kind = 'user_withdrawal_hold'), 0)::bigint as held_cents,
       coalesce((select sum(e.stake_cents) from public.entries e
                  where e.user_id = a.user_id and e.status = 'open'), 0)::bigint as in_play_cents
  from public.ledger_accounts a
  left join public.ledger_balances b on b.account_id = a.id
 where a.user_id is not null
 group by a.user_id;

-- ---------- pricing ------------------------------------------------------
create function public.power_multiplier(p_legs int) returns numeric
language sql immutable as $$
  select case p_legs when 2 then 3 when 3 then 5 when 4 then 10 when 5 then 20 when 6 then 40 end::numeric
$$;

-- ---------- money in (used by the deposit webhook in phase 4) --------------
create function public.credit_deposit(p_user uuid, p_amount_cents bigint, p_payment_ref text, p_key text)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_amount_cents <= 0 then raise exception 'invalid amount' using errcode = 'P0001'; end if;
  return public.ledger_post('deposit', p_key, jsonb_build_array(
      jsonb_build_object('account', public.ledger_account('house_payment_clearing'), 'amount', -p_amount_cents),
      jsonb_build_object('account', public.ledger_account('user_cash', p_user), 'amount', p_amount_cents)),
    p_user, null, p_payment_ref, 'deposit');
end $$;

create function public.operator_adjust(p_user uuid, p_amount_cents bigint, p_reason text, p_key text)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required' using errcode = 'P0001'; end if;
  return public.ledger_post('adjustment', p_key, jsonb_build_array(
      jsonb_build_object('account', public.ledger_account('house_adjustments'), 'amount', -p_amount_cents),
      jsonb_build_object('account', public.ledger_account('user_cash', p_user), 'amount', p_amount_cents)),
    p_user, null, null, p_reason);
end $$;

-- ---------- place an entry ----------------------------------------------
-- p_picks: [{"projection_id": "<uuid>", "direction": "more"|"less"}, ...]
create function public.place_entry(p_user uuid, p_picks jsonb, p_stake_cents bigint, p_key text)
returns public.entries
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entry public.entries;
  v_n int;
  v_teams int;
  v_players int;
  v_bad record;
  v_mult numeric;
  v_excluded timestamptz;
begin
  -- Idempotent: the same key returns the original entry.
  select * into v_entry from public.entries where user_id = p_user and idempotency_key = p_key;
  if found then return v_entry; end if;

  if p_key is null or length(p_key) < 8 then raise exception 'idempotency key required' using errcode = 'P0001'; end if;
  if p_stake_cents is null or p_stake_cents < 100 then raise exception 'stake_below_minimum' using errcode = 'P0001'; end if;
  if p_stake_cents > 100000 then raise exception 'stake_above_maximum' using errcode = 'P0001'; end if;

  select self_exclusion_until into v_excluded from public.profiles where id = p_user;
  if v_excluded is not null and v_excluded > now() then
    raise exception 'self_excluded' using errcode = 'P0001';
  end if;

  create temporary table if not exists _req (projection_id uuid, direction public.pick_direction) on commit drop;
  truncate _req;
  insert into _req
    select (x ->> 'projection_id')::uuid, (x ->> 'direction')::public.pick_direction
      from jsonb_array_elements(p_picks) x;

  select count(*) into v_n from _req;
  if v_n < 2 or v_n > 6 then raise exception 'pick_count_out_of_range' using errcode = 'P0001'; end if;
  if (select count(distinct projection_id) from _req) <> v_n then
    raise exception 'duplicate_projection' using errcode = 'P0001';
  end if;

  -- Lock the lines so they can't change or be pulled mid-placement.
  perform 1 from public.projections p join _req r on r.projection_id = p.id for share of p;

  if (select count(*) from public.projections p join _req r on r.projection_id = p.id) <> v_n then
    raise exception 'projection_not_found' using errcode = 'P0001';
  end if;

  -- Lock at start: server-side, per player's game.
  select p.id, g.starts_at, g.status as gstatus, p.status as pstatus into v_bad
    from public.projections p join _req r on r.projection_id = p.id join public.games g on g.id = p.game_id
   where p.status <> 'open' or g.status <> 'scheduled' or g.starts_at <= now()
   limit 1;
  if found then
    if v_bad.starts_at <= now() or v_bad.gstatus <> 'scheduled' then
      raise exception 'game_started' using errcode = 'P0001';
    end if;
    raise exception 'projection_unavailable' using errcode = 'P0001';
  end if;

  select count(distinct p.player_id), count(distinct p.team) into v_players, v_teams
    from public.projections p join _req r on r.projection_id = p.id;
  if v_players <> v_n then raise exception 'one_pick_per_player' using errcode = 'P0001'; end if;
  if v_teams < 2 then raise exception 'needs_two_teams' using errcode = 'P0001'; end if;

  v_mult := public.power_multiplier(v_n);

  insert into public.entries (user_id, idempotency_key, stake_cents, pick_count, multiplier, potential_payout_cents)
    values (p_user, p_key, p_stake_cents, v_n, v_mult, round(p_stake_cents * v_mult)::bigint)
    returning * into v_entry;

  insert into public.entry_picks (entry_id, projection_id, player_id, team, direction, line)
    select v_entry.id, p.id, p.player_id, p.team, r.direction, p.line
      from public.projections p join _req r on r.projection_id = p.id;

  -- Move the stake from the player's cash into escrow. Fails (and rolls
  -- everything back) if the player can't cover it.
  perform public.ledger_post('stake', 'stake:' || v_entry.id, jsonb_build_array(
      jsonb_build_object('account', public.ledger_account('user_cash', p_user), 'amount', -p_stake_cents),
      jsonb_build_object('account', public.ledger_account('house_entry_escrow'), 'amount', p_stake_cents)),
    p_user, v_entry.id, null, 'entry stake');

  return v_entry;
end $$;

-- ---------- settlement ---------------------------------------------------
-- Settles one entry if every leg is resolved. Rules:
--   any miss                    -> lost (stake to the house)
--   pushes/voids drop the leg   -> re-priced on the remaining legs
--   >= 2 remaining legs, all hit -> won at power_multiplier(remaining)
--   < 2 remaining legs           -> refunded
create function public.settle_entry(p_entry uuid)
returns public.entries
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_e public.entries;
  v_pending int;
  v_miss int;
  v_hit int;
  v_mult numeric;
  v_payout bigint;
  v_escrow bigint := public.ledger_account('house_entry_escrow');
  v_gaming bigint := public.ledger_account('house_gaming');
  v_cash bigint;
begin
  select * into v_e from public.entries where id = p_entry for update;
  if not found then raise exception 'entry_not_found' using errcode = 'P0001'; end if;
  if v_e.status <> 'open' then return v_e; end if;

  select count(*) filter (where result = 'pending'),
         count(*) filter (where result = 'miss'),
         count(*) filter (where result = 'hit')
    into v_pending, v_miss, v_hit
    from public.entry_picks where entry_id = p_entry;
  if v_pending > 0 then return v_e; end if;

  v_cash := public.ledger_account('user_cash', v_e.user_id);

  if v_miss > 0 then
    perform public.ledger_post('loss', 'settle:' || v_e.id, jsonb_build_array(
        jsonb_build_object('account', v_escrow, 'amount', -v_e.stake_cents),
        jsonb_build_object('account', v_gaming, 'amount', v_e.stake_cents)),
      v_e.user_id, v_e.id, null, 'entry lost');
    update public.entries set status = 'lost', settled_legs = v_hit, payout_cents = 0, settled_at = now()
      where id = v_e.id returning * into v_e;
  elsif v_hit >= 2 then
    v_mult := public.power_multiplier(v_hit);
    v_payout := round(v_e.stake_cents * v_mult)::bigint;
    perform public.ledger_post('payout', 'settle:' || v_e.id, jsonb_build_array(
        jsonb_build_object('account', v_escrow, 'amount', -v_e.stake_cents),
        jsonb_build_object('account', v_gaming, 'amount', v_e.stake_cents - v_payout),
        jsonb_build_object('account', v_cash, 'amount', v_payout)),
      v_e.user_id, v_e.id, null, format('entry won %s legs at %sx', v_hit, v_mult));
    update public.entries set status = 'won', settled_legs = v_hit, settled_multiplier = v_mult,
        payout_cents = v_payout, settled_at = now()
      where id = v_e.id returning * into v_e;
  else
    perform public.ledger_post('refund', 'settle:' || v_e.id, jsonb_build_array(
        jsonb_build_object('account', v_escrow, 'amount', -v_e.stake_cents),
        jsonb_build_object('account', v_cash, 'amount', v_e.stake_cents)),
      v_e.user_id, v_e.id, null, 'fewer than 2 legs remain after pushes/voids');
    update public.entries set status = 'refunded', settled_legs = v_hit, payout_cents = v_e.stake_cents, settled_at = now()
      where id = v_e.id returning * into v_e;
  end if;
  return v_e;
end $$;

-- Settle every open entry touching a projection. Returns how many settled.
create function public.settle_entries_for(p_projection uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_count int := 0;
  v_e public.entries;
begin
  for v_id in
    select distinct e.id from public.entries e join public.entry_picks ep on ep.entry_id = e.id
     where ep.projection_id = p_projection and e.status = 'open'
     order by e.id
  loop
    v_e := public.settle_entry(v_id);
    if v_e.status <> 'open' then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end $$;

-- Official final stat for a projection: grades every leg against the line
-- the player locked in, then auto-settles entries that are now complete.
create function public.grade_projection(p_projection uuid, p_value numeric)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.projections;
begin
  if p_value is null or p_value < 0 then raise exception 'invalid result' using errcode = 'P0001'; end if;
  select * into v_p from public.projections where id = p_projection for update;
  if not found then raise exception 'projection_not_found' using errcode = 'P0001'; end if;
  if v_p.status = 'final' then
    if v_p.result = p_value then return 0; end if;   -- idempotent re-delivery
    raise exception 'already_graded' using errcode = 'P0001';
  end if;
  if v_p.status = 'void' then raise exception 'projection_void' using errcode = 'P0001'; end if;

  update public.projections set status = 'final', result = p_value, current_value = p_value, updated_at = now()
    where id = p_projection;

  update public.entry_picks set
      final_value = p_value,
      result = case
        when p_value = line then 'push'::public.leg_result
        when (p_value > line) = (direction = 'more') then 'hit'::public.leg_result
        else 'miss'::public.leg_result end
    where projection_id = p_projection and result = 'pending';

  return public.settle_entries_for(p_projection);
end $$;

-- Pull/void a projection (e.g. player inactive): its legs drop out and entries re-price.
create function public.void_projection(p_projection uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.projections set status = 'void', updated_at = now()
    where id = p_projection and status in ('open', 'pulled');
  if not found and not exists (select 1 from public.projections where id = p_projection and status = 'void') then
    raise exception 'cannot_void_graded_projection' using errcode = 'P0001';
  end if;
  update public.entry_picks set result = 'void' where projection_id = p_projection and result = 'pending';
  return public.settle_entries_for(p_projection);
end $$;

-- Void a whole game: every ungraded line on it is voided.
create function public.void_game(p_game uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_count int := 0;
begin
  update public.games set status = 'void', updated_at = now() where id = p_game;
  for v_id in select id from public.projections where game_id = p_game and status in ('open', 'pulled') loop
    v_count := v_count + public.void_projection(v_id);
  end loop;
  return v_count;
end $$;

-- ---------- access control -----------------------------------------------
alter table public.profiles enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.ledger_balances enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_postings enable row level security;
alter table public.games enable row level security;
alter table public.projections enable row level security;
alter table public.entries enable row level security;
alter table public.entry_picks enable row level security;

create policy "own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "own accounts" on public.ledger_accounts for select to authenticated using (user_id = auth.uid());
create policy "own balances" on public.ledger_balances for select to authenticated
  using (exists (select 1 from public.ledger_accounts a where a.id = account_id and a.user_id = auth.uid()));
create policy "own transactions" on public.ledger_transactions for select to authenticated using (user_id = auth.uid());
create policy "own postings" on public.ledger_postings for select to authenticated
  using (exists (select 1 from public.ledger_accounts a where a.id = account_id and a.user_id = auth.uid()));
create policy "slate is public" on public.games for select to anon, authenticated using (true);
create policy "lines are public" on public.projections for select to anon, authenticated using (status <> 'pulled');
create policy "own entries" on public.entries for select to authenticated using (user_id = auth.uid());
create policy "own picks" on public.entry_picks for select to authenticated
  using (exists (select 1 from public.entries e where e.id = entry_id and e.user_id = auth.uid()));

-- Players read through RLS; nobody but the server writes.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.games, public.projections to anon, authenticated;
grant select on public.profiles, public.ledger_accounts, public.ledger_balances, public.ledger_transactions,
  public.ledger_postings, public.entries, public.entry_picks, public.wallets to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.power_multiplier(int) to anon, authenticated;
grant execute on all functions in schema public to service_role;
grant all on all tables in schema public to service_role;
