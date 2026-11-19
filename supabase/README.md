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

## Next phases

3. KYC, age (18+/21+ by state) and geofence gates · 4. deposits/withdrawals via a gaming-approved
provider with verified webhooks and reconciliation · 5. limits, self-exclusion, audit log ·
6. operator console · 7. fraud and risk.
