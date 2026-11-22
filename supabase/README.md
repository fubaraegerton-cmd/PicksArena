# Money core (Supabase / Postgres)

Server-authoritative ledger, entries and settlement for the real-money build.
Everything that touches money lives in `migrations/` as Postgres functions.

## What's here (phases 1–2)

- **Double-entry, append-only ledger** — `ledger_transactions` + `ledger_postings`.
  Every transaction sums to zero (checked at commit), rows can't be updated/deleted/truncated,
  every write has a unique idempotency key, and player cash can never go negative.
  `ledger_reconcile()` returns any cached balance that disagrees with its postings (empty = healthy).
- **Accounts** — `user_cash`, `user_withdrawal_hold`, `house_entry_escrow`, `house_gaming`,
  `house_payment_clearing`, `house_adjustments`. `wallets` view = available / held / in play.
- **Entries** — `place_entry(user, picks, stake_cents, key)`: 2–6 picks, one per player, at least two
  teams, $1–$1,000 stake, self-exclusion check, **lock at each player's game start** (server-side),
  line snapshot per pick, stake moved to escrow. Idempotent on `key`.
- **Pricing** — Power only: 2=3x, 3=5x, 4=10x, 5=20x, 6=40x.
- **Grading & auto-settlement** — `grade_projection(id, value)` grades every leg against the line the
  player locked in and settles entries whose legs are all final:
  any miss → lost; pushes/voids drop out and the entry re-prices on remaining legs;
  fewer than 2 legs left → refunded. `void_projection`, `void_game` for scratches/cancellations.
  Re-delivered results are no-ops; conflicting results are refused.
- **Access** — RLS on every table; players read only their own rows; only `service_role`
  (server endpoints) can execute money functions.

Also used later: `credit_deposit` (called only from the verified payment webhook) and
`operator_adjust` (reason required).

## Tests

`tests/ledger.test.ts` runs against a real, throwaway Postgres (it creates and drops `pa_ledger_test`):

```bash
PA_TEST_PG_HOST=/path/to/socket-or-host PA_TEST_PG_PORT=5432 npm test
```

`tests/supabase_shim.sql` stands in for Supabase's `auth` schema and roles on plain Postgres —
never run it against a real Supabase project.

## Phase 3 — compliance gates (`20261120000003_compliance_gates.sql`)

- `jurisdictions` — every state, **all disabled by default**, with a minimum age. Managed in the
  operator Compliance tab.
- `geo_checks` — append-only log of every location decision. `place_entry(…, p_geo_check)` requires a
  fresh (≤2 minutes) `allow` check for that player in an enabled state; the old function is renamed
  `place_entry_unchecked` and nobody (not even `service_role`) can call it directly.
- Age = stricter of home state and current location (`min_age_for`), re-checked on every entry.
- `kyc_records` + `set_kyc_decision` — decisions only; one verified identity per account (unique index).
- `devices` + `record_device` — accounts sharing a device are flagged; `flags.blocked` puts an account on hold.

## Phase 4 — payments (`20261121000004_payments.sql`)

- `payments`, `payment_methods` (tokens only), append-only `payment_events`, `provider_settlements`.
- `start_deposit` → hosted checkout → `process_payment_event('deposit.succeeded')` credits only when
  the amount matches; duplicate event ids return `duplicate`.
- `request_withdrawal` (KYC + closed-loop method + location) → `review_withdrawal` → `payout.paid`;
  `cancel_withdrawal`, decline and `payout.failed` return held funds.
- `deposit.reversed` (chargeback) freezes the account and claws back unspent cash.
- `reconcile_payments()` — processor report vs payments vs ledger; empty = healthy.

## Phase 5 — responsible gaming, audit, rate limits (`…000005`, `…000006`)

- `player_limits` + `set_limit` / `current_limit` / `limit_usage` / `enforce_limits` — deposit, stake
  and loss limits per rolling day/week/month, enforced inside `start_deposit` and `place_entry`.
  Stricter = immediate; looser or removed = after 24 hours.
- `player_exclusions` + `set_exclusion` — cool-off and self-exclusion; a trigger stops
  `self_exclusion_until` from ever being shortened.
- `spend_summary(user)` — deposits, withdrawals, staked, won back per period.
- `audit_log` + `audit_capture` triggers + `log_audit` — append-only trail of every sensitive change.
- `hit_rate_limit(key, max, window_seconds)` — fixed-window counters for the API.

## Phase 6 — operator console (`…000007`)

- `force_settle_leg(entry, projection, 'hit'|'miss'|'void', reason, by)` — decides one pending leg, then settles.
- `fail_pending_deposit(payment, reason, by)` — open checkout → failed; no money moves.
- `player_sessions(user)` — Supabase Auth sessions as JSON, for the console.

## Venom / Shield and countries (`…000008`)

- `projections.tier` (`standard`/`venom`/`shield`) + `payout_factor`; `entry_picks.payout_factor` snapshot.
- `entry_multiplier(legs, factor)` = power table × factor, 2 decimals, max 1000×.
- `place_entry_unchecked` rejects Less on tiered lines (`tiered_more_only`) and flex with tiered lines;
  `settle_entry` multiplies the factors of the legs that hit (pushes/voids drop out).
- `countries` (250 ISO codes, all disabled, `min_age`), `profiles.country`,
  `place_enabled(country, region)`, `min_age_for_place(home_country, home_region, loc_country, loc_region)`;
  `money_gate` and `place_entry` use them.
- Automatic Venom lines are created by the app (`autoVenom` in `src/shared/admin.ts`), not the database.

## Next phases

7. fraud and risk.
