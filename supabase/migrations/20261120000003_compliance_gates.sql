-- =====================================================================
-- Phase 3: identity, age and geography gates.
--
--   * jurisdictions  — operator-managed list of eligible states + minimum age.
--                      Everything starts disabled: nothing is playable until an
--                      operator switches a licensed state on.
--   * geo_checks     — append-only log of every location decision.
--   * place_entry    — now REQUIRES a fresh 'allow' geo check for the entry
--                      action, so the database enforces the geofence even if
--                      server code has a bug.
--   * kyc_records    — provider decisions only (no documents). One verified
--                      identity can be approved on one account only.
--   * devices        — device fingerprints; a device shared by several
--                      accounts flags all of them for review.
-- =====================================================================

-- Generic guard for append-only tables
create function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only (%)', tg_table_name, tg_op using errcode = 'P0001';
end $$;

-- ---------- jurisdictions ---------------------------------------------------
create table public.jurisdictions (
  state char(2) primary key check (state ~ '^[A-Z]{2}$'),
  name text not null,
  enabled boolean not null default false,
  min_age smallint not null default 21 check (min_age between 18 and 25),
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into public.jurisdictions (state, name) values
  ('AL','Alabama'),('AK','Alaska'),('AZ','Arizona'),('AR','Arkansas'),('CA','California'),('CO','Colorado'),
  ('CT','Connecticut'),('DE','Delaware'),('DC','District of Columbia'),('FL','Florida'),('GA','Georgia'),
  ('HI','Hawaii'),('ID','Idaho'),('IL','Illinois'),('IN','Indiana'),('IA','Iowa'),('KS','Kansas'),
  ('KY','Kentucky'),('LA','Louisiana'),('ME','Maine'),('MD','Maryland'),('MA','Massachusetts'),
  ('MI','Michigan'),('MN','Minnesota'),('MS','Mississippi'),('MO','Missouri'),('MT','Montana'),
  ('NE','Nebraska'),('NV','Nevada'),('NH','New Hampshire'),('NJ','New Jersey'),('NM','New Mexico'),
  ('NY','New York'),('NC','North Carolina'),('ND','North Dakota'),('OH','Ohio'),('OK','Oklahoma'),
  ('OR','Oregon'),('PA','Pennsylvania'),('RI','Rhode Island'),('SC','South Carolina'),('SD','South Dakota'),
  ('TN','Tennessee'),('TX','Texas'),('UT','Utah'),('VT','Vermont'),('VA','Virginia'),('WA','Washington'),
  ('WV','West Virginia'),('WI','Wisconsin'),('WY','Wyoming');

-- ---------- geo checks ----------------------------------------------------
create table public.geo_checks (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  action text not null check (action in ('signup', 'entry', 'deposit', 'withdrawal')),
  ip inet,
  country char(2),
  region text,
  is_vpn boolean,
  provider text not null,
  decision text not null check (decision in ('allow', 'deny')),
  reason text,
  device_hash text,
  created_at timestamptz not null default now()
);
create index on public.geo_checks (user_id, created_at desc);
create index on public.geo_checks (created_at desc) where decision = 'deny';
create trigger geo_checks_append_only before update or delete on public.geo_checks
  for each row execute function public.forbid_mutation();

-- ---------- KYC -----------------------------------------------------------
create table public.kyc_records (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  provider text not null,
  provider_ref text,
  status text not null check (status in ('pending', 'review', 'approved', 'rejected')),
  reason text,
  identity_hash text,          -- one-way hash of name + DOB (+ ID number) from the provider
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  unique (provider, provider_ref)
);
create index on public.kyc_records (user_id, created_at desc);
create index on public.kyc_records (status) where status in ('pending', 'review');
-- One verified person, one account.
create unique index kyc_one_account_per_identity on public.kyc_records (identity_hash) where status = 'approved';

-- Apply a KYC decision and mirror it onto the profile. Duplicate identities are rejected.
create function public.set_kyc_decision(
  p_record bigint, p_status text, p_reason text, p_identity_hash text, p_decided_by text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rec public.kyc_records;
  v_status text := p_status;
  v_reason text := p_reason;
begin
  if p_status not in ('review', 'approved', 'rejected') then raise exception 'invalid kyc status' using errcode = 'P0001'; end if;
  select * into v_rec from public.kyc_records where id = p_record for update;
  if not found then raise exception 'kyc_record_not_found' using errcode = 'P0001'; end if;
  if v_rec.status in ('approved', 'rejected') and v_rec.status <> p_status then
    raise exception 'kyc_already_decided' using errcode = 'P0001';
  end if;

  if v_status = 'approved' and p_identity_hash is not null and exists (
    select 1 from public.kyc_records
     where identity_hash = p_identity_hash and status = 'approved' and user_id <> v_rec.user_id
  ) then
    v_status := 'rejected';
    v_reason := 'duplicate_identity';
    update public.profiles set flags = flags || jsonb_build_object('duplicate_identity', true) where id = v_rec.user_id;
  end if;

  update public.kyc_records
     set status = v_status, reason = v_reason, identity_hash = coalesce(p_identity_hash, identity_hash),
         decided_at = case when v_status in ('approved', 'rejected') then now() end,
         decided_by = p_decided_by
   where id = p_record;

  update public.profiles
     set kyc_status = case v_status when 'review' then 'pending' else v_status end
   where id = v_rec.user_id;
  return v_status;
end $$;

-- ---------- devices -------------------------------------------------------
create table public.devices (
  user_id uuid not null references auth.users (id),
  device_hash text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, device_hash)
);
create index on public.devices (device_hash);

-- Records a device for a user; if another account used it, flags every account on it.
create function public.record_device(p_user uuid, p_device_hash text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shared boolean;
begin
  if p_device_hash is null or length(p_device_hash) < 16 then return false; end if;
  insert into public.devices (user_id, device_hash) values (p_user, p_device_hash)
  on conflict (user_id, device_hash) do update set last_seen = now();
  select count(distinct user_id) > 1 into v_shared from public.devices where device_hash = p_device_hash;
  if v_shared then
    update public.profiles set flags = flags || jsonb_build_object('shared_device', true)
     where id in (select user_id from public.devices where device_hash = p_device_hash);
  end if;
  return v_shared;
end $$;

-- ---------- minimum age ---------------------------------------------------
-- Strictest of the player's home state and where they are right now.
create function public.min_age_for(p_home char(2), p_located char(2)) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(
    coalesce((select min_age from public.jurisdictions where state = p_home), 21),
    coalesce((select min_age from public.jurisdictions where state = p_located), 21),
    18)
$$;

-- ---------- geofenced entry placement -------------------------------------
-- The phase-1 function becomes internal; only this wrapper may call it.
alter function public.place_entry(uuid, jsonb, bigint, text) rename to place_entry_unchecked;
revoke execute on function public.place_entry_unchecked(uuid, jsonb, bigint, text) from public, anon, authenticated, service_role;

create function public.place_entry(p_user uuid, p_picks jsonb, p_stake_cents bigint, p_key text, p_geo_check bigint)
returns public.entries
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_geo public.geo_checks;
  v_profile public.profiles;
  v_existing public.entries;
begin
  -- A replayed request returns the original entry without new checks.
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

  return public.place_entry_unchecked(p_user, p_picks, p_stake_cents, p_key);
end $$;

-- ---------- access ----------------------------------------------------------
alter table public.jurisdictions enable row level security;
alter table public.geo_checks enable row level security;
alter table public.kyc_records enable row level security;
alter table public.devices enable row level security;

create policy "eligible states are public" on public.jurisdictions for select to anon, authenticated using (true);
create policy "own kyc status" on public.kyc_records for select to authenticated using (user_id = auth.uid());

revoke all on public.jurisdictions, public.geo_checks, public.kyc_records, public.devices from anon, authenticated;
grant select on public.jurisdictions to anon, authenticated;
grant select (id, status, reason, created_at, decided_at) on public.kyc_records to authenticated;

revoke execute on function public.forbid_mutation(), public.set_kyc_decision(bigint, text, text, text, text),
  public.record_device(uuid, text), public.min_age_for(char, char),
  public.place_entry(uuid, jsonb, bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.set_kyc_decision(bigint, text, text, text, text), public.record_device(uuid, text),
  public.min_age_for(char, char), public.place_entry(uuid, jsonb, bigint, text, bigint) to service_role;
grant all on public.jurisdictions, public.geo_checks, public.kyc_records, public.devices to service_role;
