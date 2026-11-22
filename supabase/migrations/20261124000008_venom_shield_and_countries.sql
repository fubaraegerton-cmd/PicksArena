-- =====================================================================
-- Venom / Shield picks and worldwide registration.
--
-- Venom and Shield are alternate lines for the same player and stat:
--   * Venom  — a harder line; More only; multiplies the entry payout by its factor (> 1).
--   * Shield — an easier line; More only; multiplies the entry payout by its factor (< 1).
--   Entry multiplier = power_multiplier(legs) × product of the legs' factors, rounded to
--   2 decimals and capped at 1000×. On settlement the multiplier is re-priced on the legs
--   that hit (pushes/voids drop out with their factors). Factors are snapshotted per pick.
--
-- Countries: anyone can register from any country. Real-money play is enabled per country
-- (and per US state, as before) by an operator. Everything starts disabled.
-- =====================================================================

-- ---------- tiers ------------------------------------------------------------
alter table public.projections
  add column tier text not null default 'standard' check (tier in ('standard', 'venom', 'shield')),
  add column payout_factor numeric(4, 2) not null default 1 check (payout_factor > 0 and payout_factor <= 5),
  add constraint projections_tier_factor check (
    (tier = 'standard' and payout_factor = 1) or
    (tier = 'venom' and payout_factor > 1) or
    (tier = 'shield' and payout_factor < 1));
drop index public.projections_one_open_line;
create unique index projections_one_open_line on public.projections (game_id, player_id, stat_type, tier) where status = 'open';

alter table public.entry_picks add column payout_factor numeric(4, 2) not null default 1;

create function public.entry_multiplier(p_legs int, p_factor numeric) returns numeric
language sql immutable as $$
  select least(round(public.power_multiplier(p_legs) * coalesce(p_factor, 1), 2), 1000)
$$;

-- ---------- countries --------------------------------------------------------
create table public.countries (
  code char(2) primary key check (code ~ '^[A-Z]{2}$'),
  name text not null,
  enabled boolean not null default false,
  min_age smallint not null default 18 check (min_age between 18 and 25),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.countries (code, name) values
  ('AD','Andorra'),
  ('AE','United Arab Emirates'),
  ('AF','Afghanistan'),
  ('AG','Antigua & Barbuda'),
  ('AI','Anguilla'),
  ('AL','Albania'),
  ('AM','Armenia'),
  ('AO','Angola'),
  ('AQ','Antarctica'),
  ('AR','Argentina'),
  ('AS','American Samoa'),
  ('AT','Austria'),
  ('AU','Australia'),
  ('AW','Aruba'),
  ('AX','Åland Islands'),
  ('AZ','Azerbaijan'),
  ('BA','Bosnia & Herzegovina'),
  ('BB','Barbados'),
  ('BD','Bangladesh'),
  ('BE','Belgium'),
  ('BF','Burkina Faso'),
  ('BG','Bulgaria'),
  ('BH','Bahrain'),
  ('BI','Burundi'),
  ('BJ','Benin'),
  ('BL','St. Barthélemy'),
  ('BM','Bermuda'),
  ('BN','Brunei'),
  ('BO','Bolivia'),
  ('BQ','Caribbean Netherlands'),
  ('BR','Brazil'),
  ('BS','Bahamas'),
  ('BT','Bhutan'),
  ('BV','Bouvet Island'),
  ('BW','Botswana'),
  ('BY','Belarus'),
  ('BZ','Belize'),
  ('CA','Canada'),
  ('CC','Cocos (Keeling) Islands'),
  ('CD','Congo - Kinshasa'),
  ('CF','Central African Republic'),
  ('CG','Congo - Brazzaville'),
  ('CH','Switzerland'),
  ('CI','Côte d’Ivoire'),
  ('CK','Cook Islands'),
  ('CL','Chile'),
  ('CM','Cameroon'),
  ('CN','China'),
  ('CO','Colombia'),
  ('CR','Costa Rica'),
  ('CU','Cuba'),
  ('CV','Cape Verde'),
  ('CW','Curaçao'),
  ('CX','Christmas Island'),
  ('CY','Cyprus'),
  ('CZ','Czechia'),
  ('DE','Germany'),
  ('DJ','Djibouti'),
  ('DK','Denmark'),
  ('DM','Dominica'),
  ('DO','Dominican Republic'),
  ('DZ','Algeria'),
  ('EC','Ecuador'),
  ('EE','Estonia'),
  ('EG','Egypt'),
  ('EH','Western Sahara'),
  ('ER','Eritrea'),
  ('ES','Spain'),
  ('ET','Ethiopia'),
  ('FI','Finland'),
  ('FJ','Fiji'),
  ('FK','Falkland Islands'),
  ('FM','Micronesia'),
  ('FO','Faroe Islands'),
  ('FR','France'),
  ('GA','Gabon'),
  ('GB','United Kingdom'),
  ('GD','Grenada'),
  ('GE','Georgia'),
  ('GF','French Guiana'),
  ('GG','Guernsey'),
  ('GH','Ghana'),
  ('GI','Gibraltar'),
  ('GL','Greenland'),
  ('GM','Gambia'),
  ('GN','Guinea'),
  ('GP','Guadeloupe'),
  ('GQ','Equatorial Guinea'),
  ('GR','Greece'),
  ('GS','South Georgia & South Sandwich Islands'),
  ('GT','Guatemala'),
  ('GU','Guam'),
  ('GW','Guinea-Bissau'),
  ('GY','Guyana'),
  ('HK','Hong Kong SAR China'),
  ('HM','Heard & McDonald Islands'),
  ('HN','Honduras'),
  ('HR','Croatia'),
  ('HT','Haiti'),
  ('HU','Hungary'),
  ('ID','Indonesia'),
  ('IE','Ireland'),
  ('IL','Israel'),
  ('IM','Isle of Man'),
  ('IN','India'),
  ('IO','British Indian Ocean Territory'),
  ('IQ','Iraq'),
  ('IR','Iran'),
  ('IS','Iceland'),
  ('IT','Italy'),
  ('JE','Jersey'),
  ('JM','Jamaica'),
  ('JO','Jordan'),
  ('JP','Japan'),
  ('KE','Kenya'),
  ('KG','Kyrgyzstan'),
  ('KH','Cambodia'),
  ('KI','Kiribati'),
  ('KM','Comoros'),
  ('KN','St. Kitts & Nevis'),
  ('KP','North Korea'),
  ('KR','South Korea'),
  ('KW','Kuwait'),
  ('KY','Cayman Islands'),
  ('KZ','Kazakhstan'),
  ('LA','Laos'),
  ('LB','Lebanon'),
  ('LC','St. Lucia'),
  ('LI','Liechtenstein'),
  ('LK','Sri Lanka'),
  ('LR','Liberia'),
  ('LS','Lesotho'),
  ('LT','Lithuania'),
  ('LU','Luxembourg'),
  ('LV','Latvia'),
  ('LY','Libya'),
  ('MA','Morocco'),
  ('MC','Monaco'),
  ('MD','Moldova'),
  ('ME','Montenegro'),
  ('MF','St. Martin'),
  ('MG','Madagascar'),
  ('MH','Marshall Islands'),
  ('MK','North Macedonia'),
  ('ML','Mali'),
  ('MM','Myanmar (Burma)'),
  ('MN','Mongolia'),
  ('MO','Macao SAR China'),
  ('MP','Northern Mariana Islands'),
  ('MQ','Martinique'),
  ('MR','Mauritania'),
  ('MS','Montserrat'),
  ('MT','Malta'),
  ('MU','Mauritius'),
  ('MV','Maldives'),
  ('MW','Malawi'),
  ('MX','Mexico'),
  ('MY','Malaysia'),
  ('MZ','Mozambique'),
  ('NA','Namibia'),
  ('NC','New Caledonia'),
  ('NE','Niger'),
  ('NF','Norfolk Island'),
  ('NG','Nigeria'),
  ('NI','Nicaragua'),
  ('NL','Netherlands'),
  ('NO','Norway'),
  ('NP','Nepal'),
  ('NR','Nauru'),
  ('NU','Niue'),
  ('NZ','New Zealand'),
  ('OM','Oman'),
  ('PA','Panama'),
  ('PE','Peru'),
  ('PF','French Polynesia'),
  ('PG','Papua New Guinea'),
  ('PH','Philippines'),
  ('PK','Pakistan'),
  ('PL','Poland'),
  ('PM','St. Pierre & Miquelon'),
  ('PN','Pitcairn Islands'),
  ('PR','Puerto Rico'),
  ('PS','Palestinian Territories'),
  ('PT','Portugal'),
  ('PW','Palau'),
  ('PY','Paraguay'),
  ('QA','Qatar'),
  ('RE','Réunion'),
  ('RO','Romania'),
  ('RS','Serbia'),
  ('RU','Russia'),
  ('RW','Rwanda'),
  ('SA','Saudi Arabia'),
  ('SB','Solomon Islands'),
  ('SC','Seychelles'),
  ('SD','Sudan'),
  ('SE','Sweden'),
  ('SG','Singapore'),
  ('SH','St. Helena'),
  ('SI','Slovenia'),
  ('SJ','Svalbard & Jan Mayen'),
  ('SK','Slovakia'),
  ('SL','Sierra Leone'),
  ('SM','San Marino'),
  ('SN','Senegal'),
  ('SO','Somalia'),
  ('SR','Suriname'),
  ('SS','South Sudan'),
  ('ST','São Tomé & Príncipe'),
  ('SV','El Salvador'),
  ('SX','Sint Maarten'),
  ('SY','Syria'),
  ('SZ','Eswatini'),
  ('TC','Turks & Caicos Islands'),
  ('TD','Chad'),
  ('TF','French Southern Territories'),
  ('TG','Togo'),
  ('TH','Thailand'),
  ('TJ','Tajikistan'),
  ('TK','Tokelau'),
  ('TL','Timor-Leste'),
  ('TM','Turkmenistan'),
  ('TN','Tunisia'),
  ('TO','Tonga'),
  ('TR','Türkiye'),
  ('TT','Trinidad & Tobago'),
  ('TV','Tuvalu'),
  ('TW','Taiwan'),
  ('TZ','Tanzania'),
  ('UA','Ukraine'),
  ('UG','Uganda'),
  ('UM','U.S. Outlying Islands'),
  ('US','United States'),
  ('UY','Uruguay'),
  ('UZ','Uzbekistan'),
  ('VA','Vatican City'),
  ('VC','St. Vincent & Grenadines'),
  ('VE','Venezuela'),
  ('VG','British Virgin Islands'),
  ('VI','U.S. Virgin Islands'),
  ('VN','Vietnam'),
  ('VU','Vanuatu'),
  ('WF','Wallis & Futuna'),
  ('WS','Samoa'),
  ('XK','Kosovo'),
  ('YE','Yemen'),
  ('YT','Mayotte'),
  ('ZA','South Africa'),
  ('ZM','Zambia'),
  ('ZW','Zimbabwe');
-- The US is governed state by state (jurisdictions); its country row only provides the name.
update public.countries set min_age = 21 where code = 'US';

alter table public.profiles add column country char(2) not null default 'US' check (country ~ '^[A-Z]{2}$');

-- Can real money be played at this location right now?
create function public.place_enabled(p_country text, p_region text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_country is null then false
    when p_country = 'US' then exists (select 1 from public.jurisdictions where state = p_region and enabled)
    else exists (select 1 from public.countries where code = p_country and enabled)
  end
$$;

create function public.min_age_at(p_country text, p_region text) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_country = 'US' or p_country is null then coalesce((select min_age from public.jurisdictions where state = p_region), 21)
    else coalesce((select min_age from public.countries where code = p_country), 21)
  end
$$;

-- Strictest of where the player lives and where they are right now.
create function public.min_age_for_place(p_home_country text, p_home_region text, p_loc_country text, p_loc_region text) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(public.min_age_at(coalesce(p_home_country, 'US'), p_home_region), public.min_age_at(p_loc_country, p_loc_region), 18)
$$;

-- ---------- pricing with Venom/Shield factors ----------------------------------
create or replace function public.place_entry_unchecked(p_user uuid, p_picks jsonb, p_stake_cents bigint, p_key text)
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
  v_factor numeric;
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

  -- Venom/Shield lines are More-only; their payout factors multiply the entry's multiplier.
  if exists (select 1 from public.projections p join _req r on r.projection_id = p.id
              where p.tier <> 'standard' and r.direction <> 'more') then
    raise exception 'tiered_more_only' using errcode = 'P0001';
  end if;
  select coalesce(exp(sum(ln(p.payout_factor))), 1) into v_factor
    from public.projections p join _req r on r.projection_id = p.id;
  v_mult := public.entry_multiplier(v_n, v_factor);

  insert into public.entries (user_id, idempotency_key, stake_cents, pick_count, multiplier, potential_payout_cents)
    values (p_user, p_key, p_stake_cents, v_n, v_mult, round(p_stake_cents * v_mult)::bigint)
    returning * into v_entry;

  insert into public.entry_picks (entry_id, projection_id, player_id, team, direction, line, payout_factor)
    select v_entry.id, p.id, p.player_id, p.team, r.direction, p.line, p.payout_factor
      from public.projections p join _req r on r.projection_id = p.id;

  -- Move the stake from the player's cash into escrow. Fails (and rolls
  -- everything back) if the player can't cover it.
  perform public.ledger_post('stake', 'stake:' || v_entry.id, jsonb_build_array(
      jsonb_build_object('account', public.ledger_account('user_cash', p_user), 'amount', -p_stake_cents),
      jsonb_build_object('account', public.ledger_account('house_entry_escrow'), 'amount', p_stake_cents)),
    p_user, v_entry.id, null, 'entry stake');

  return v_entry;
end $$;

create or replace function public.settle_entry(p_entry uuid)
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
    -- Re-priced on the legs that hit, including their Venom/Shield factors.
    v_mult := public.entry_multiplier(v_hit,
      (select coalesce(exp(sum(ln(payout_factor))), 1) from public.entry_picks where entry_id = p_entry and result = 'hit'));
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

-- ---------- country-aware gates ------------------------------------------------
create or replace function public.money_gate(p_user uuid, p_geo bigint, p_action text) returns public.profiles
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
  if not public.place_enabled(v_geo.country, v_geo.region) then
    raise exception 'location_not_eligible' using errcode = 'P0001';
  end if;
  select * into v_p from public.profiles where id = p_user;
  if v_p.dob is null then raise exception 'profile_required' using errcode = 'P0001'; end if;
  if date_part('year', age(current_date, v_p.dob)) < public.min_age_for_place(v_p.country, v_p.state, v_geo.country, v_geo.region) then
    raise exception 'under_age' using errcode = 'P0001';
  end if;
  if coalesce((v_p.flags ->> 'blocked')::boolean, false) then raise exception 'account_blocked' using errcode = 'P0001'; end if;
  return v_p;
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
  if not public.place_enabled(v_geo.country, v_geo.region) then
    raise exception 'location_not_eligible' using errcode = 'P0001';
  end if;

  select * into v_profile from public.profiles where id = p_user;
  if v_profile.dob is null then raise exception 'profile_required' using errcode = 'P0001'; end if;
  if date_part('year', age(current_date, v_profile.dob)) < public.min_age_for_place(v_profile.country, v_profile.state, v_geo.country, v_geo.region) then
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

-- ---------- access ----------------------------------------------------------
alter table public.countries enable row level security;
create policy "countries are public" on public.countries for select to anon, authenticated using (true);
revoke all on public.countries from anon, authenticated;
grant select on public.countries to anon, authenticated;
grant all on public.countries to service_role;

revoke execute on function public.place_enabled(text, text), public.min_age_at(text, text),
  public.min_age_for_place(text, text, text, text) from public, anon, authenticated;
grant execute on function public.place_enabled(text, text), public.min_age_at(text, text),
  public.min_age_for_place(text, text, text, text), public.entry_multiplier(int, numeric) to service_role;
grant execute on function public.entry_multiplier(int, numeric) to anon, authenticated;
revoke execute on function public.place_entry_unchecked(uuid, jsonb, bigint, text) from public, anon, authenticated, service_role;
