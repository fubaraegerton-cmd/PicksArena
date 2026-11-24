# PicksArena build playbook

How PicksArena was built, step by step, with the decisions, commands and mistakes along the
way, written so the same path can be followed for a similar product (a pick'em, sportsbook-style
or any real-money app with a ledger).

- **What it is:** a mobile-first daily fantasy pick'em app. Players call More or Less on player
  stat lines, combine 2–6 picks into an entry and win a fixed multiplier if every pick hits.
- **Stack:** React 18 + TypeScript + Vite (PWA) · Vercel (hosting + serverless functions) ·
  Supabase (Postgres, Auth, row-level security) · Vitest + Playwright for testing.
- **Repo layout:** `src/` app · `api/` Vercel functions · `server/` server code they share ·
  `supabase/migrations/` database · `supabase/tests/` database tests · `docs/` this file.

---

## 0. The order that worked

Build in this order. Each step is usable on its own, and each later step depends on the earlier
ones being right.

| # | Step | Outcome |
|---|------|---------|
| 1 | Play-money prototype | The whole product loop in the browser, no backend |
| 2 | Mobile-first redesign + PWA | Installable, native-feeling app |
| 3 | Deploy to Vercel | Live URL |
| 4 | Operator dashboard (Blob storage) | House can post games and special picks |
| 5 | Home page | Landing page built on real data |
| 6 | Money core in Postgres (phases 1–2) | Ledger, entries, lock-at-start, auto-settlement |
| 7 | Connect the app to Supabase | Real accounts, server-placed entries, live wallet |
| 8 | Compliance gates (phase 3) | Geofence, age by state, identity checks, one account per person |
| 9 | Payments (phase 4) | Deposits/withdrawals behind a processor adapter, signed webhooks, reconciliation |
| 10 | Responsible gaming + audit (phase 5) | Limits, breaks, self-exclusion, spend summary, reminders, audit log, rate limits |
| 11 | Operator console (phase 6) | Player lookup, case actions, leg force-settle, line overrides, reason codes, operator management |

The single most important lesson: **build the money core and its tests before any payment or
UI work for real money.** Everything else is replaceable; ledger mistakes are not.

---

## 1. Play-money prototype

Goal: prove the product loop with zero infrastructure.

1. Scaffold: `npm init -y`, then install exact versions (pin everything, no `^`):
   `react@18.3.1 react-dom@18.3.1 react-router-dom@6.28.0`, dev: `vite typescript vitest @vitejs/plugin-react`.
2. Model the domain in `src/types.ts` first (Team, Game, Player, Projection, Pick, Entry).
3. Generate a believable board with a **seeded** random generator (`src/lib/random.ts`,
   `src/data/generate.ts`) so the board is stable across reloads and tests are deterministic.
   Use fictional players/teams to avoid licensing real names and stale rosters.
4. Put rules in pure functions (`src/lib/payouts.ts`: payout tables + `validateLineup`) and unit-test them.
5. State in one React context (`src/store.tsx`) persisted to `localStorage`.
6. Pages: Board, Lineups, How to play. Settlement simulated client-side (`src/lib/simulate.ts`).

**Check before moving on:** `npm test`, `npm run build`, and a Playwright run of the full loop
(pick → place → settle) on desktop and an emulated iPhone.

## 2. Mobile-first redesign + PWA

1. `vite-plugin-pwa`: manifest (standalone display, theme colours, maskable icons), Workbox
   offline cache. **Exclude `/api/` from the navigation fallback** or API calls get the HTML shell.
2. Native patterns: bottom tab bar, app bar, safe-area insets (`env(safe-area-inset-*)`,
   `viewport-fit=cover`), drag-to-dismiss bottom sheet, press states, `navigator.vibrate` haptics,
   16px inputs (stops iOS zoom).
3. Design tokens in CSS custom properties with light and dark themes; one display font with a
   width axis (Archivo variable) carrying the personality.
4. Generate PNG icons from SVG with Playwright screenshots (no image tools needed).

**Pitfalls hit:** a grid column of `1fr` lets wide children (scrolling chip rows) blow the page
out sideways on phones — use `minmax(0, 1fr)`. A hover style that sets text to the same colour as
the selected background made a button unreadable. Always check `scrollWidth === innerWidth` in tests.

## 3. Deploy to Vercel

1. `vercel.json`: framework `vite`, output `dist`, SPA rewrite that **excludes `/api/`**:
   `{ "source": "/((?!api/).*)", "destination": "/index.html" }`.
2. Deploy with the CLI and a token: `npx vercel@<pinned> deploy --prod --yes --scope <team>`.
   If the folder name has capitals, `vercel link --yes --project <lowercase-name>` first.
3. Connect the Git repo in the Vercel dashboard (**Settings → Git**) so pushes deploy.
4. Add a `.vercelignore` with `.env*` so local secrets can never be uploaded by the CLI.

**Notes:** Vercel re-creates a `<project>-<team>.vercel.app` alias on every production deploy;
remove it each time if you only want one address. New projects default to **Deployment
Protection** (Vercel login wall); keep it on until you're ready for the public.

## 4. Operator dashboard

1. Shared data needs a server: Vercel functions in `api/*.ts` using the Web `Request/Response`
   signature (`export function GET(request: Request)`), sharing code from `server/`.
2. One validation module used by both server and client (`src/shared/admin.ts`) so rules can't drift.
3. Local dev runs the same handlers through a small Vite middleware (`vite.config.ts → devApi`)
   that routes `/api/x/y` to `api/x/y.ts`, like Vercel does.
4. First storage was Vercel Blob (append new immutable JSON, read newest). Later replaced by Postgres.

## 5. Home page

Used the `frontend-design` skill: write a short design plan (palette, type, layout, principles),
check it against generic defaults, then build. Lead with the subject's most characteristic thing
(here: the featured stat line as giant type with working More/Less buttons), keep everything else quiet.

## 6. Money core in Postgres (phases 1–2)

All money rules live in the database as functions, so no app bug can bypass them.

1. **Double-entry, append-only ledger** (`supabase/migrations/…_ledger_and_entries.sql`):
   - `ledger_transactions` + `ledger_postings`; a deferred constraint trigger checks every
     transaction sums to zero with ≥2 postings.
   - Triggers forbid UPDATE/DELETE/TRUNCATE on ledger tables.
   - A cached `ledger_balances` row per account, updated by trigger; non-house accounts can't go
     negative (this also serializes concurrent spends).
   - Every write has a unique **idempotency key**, so retried webhooks/requests never double-post.
   - `ledger_reconcile()` returns any balance that disagrees with its postings.
2. **Accounts:** `user_cash`, `user_withdrawal_hold`, `house_entry_escrow`, `house_gaming`,
   `house_payment_clearing`, `house_adjustments`.
3. **Entries:** `place_entry()` validates picks, prices from a server table, snapshots each
   pick's line, locks at each game's start, and moves the stake to escrow — in one transaction.
4. **Settlement:** `grade_projection()` grades legs against the locked-in line; pushes/voids drop
   out and re-price; <2 legs refund; any miss loses. Re-delivered results are no-ops; conflicting
   ones are refused.
5. **Access:** RLS on every table, players read only their own rows, money functions executable
   only by `service_role`.

**Testing approach that paid off:** run a real Postgres locally (`initdb`/`pg_ctl` as the
`postgres` user), a tiny shim for Supabase's `auth` schema and roles
(`supabase/tests/supabase_shim.sql`), and integration tests in Vitest using `pg`
(`supabase/tests/ledger.test.ts`). Include a concurrency test (5 parallel entries against one
balance → exactly one succeeds). Run with
`PA_TEST_PG_HOST=<socket dir> PA_TEST_PG_PORT=<port> npm test`.

**Applying to Supabase without the CLI:** Management API
`POST https://api.supabase.com/v1/projects/<ref>/database/query` with `{ "query": "<sql>" }`,
then record it in `supabase_migrations.schema_migrations`. Smoke-test on the live database
inside a `DO` block that ends with `raise exception 'RESULT …'` so everything rolls back.

## 7. Connect the app to Supabase

1. Keys: use the **publishable** key in the browser (`VITE_SUPABASE_*`) and the **secret** key
   only on the server (`SUPABASE_SECRET_KEY`, stored as a *sensitive* Vercel env var).
   Copy them Supabase → Vercel with a pipe so they're never printed.
2. Server endpoints verify the player's access token (`auth.getUser(token)`), then call
   database functions with the secret key. Clients never send prices or payouts.
3. Real-money mode is switched on by the presence of Supabase env vars, so the play-money demo
   still runs locally without them.
4. Operator access = `app_metadata.role = 'operator'` (only settable server-side), checked on
   every admin request — not a shared password.
5. Set Supabase **Auth → Site URL** to the live domain (defaults to `localhost:3000`, which
   breaks confirmation and reset emails).

**Bugs found only by end-to-end testing against the real project:**
- A refresh loop (a new session object every refresh re-triggered the effect) flooded Supabase.
  Keep identity objects stable; key effects on the user id.
- Calling Supabase inside `onAuthStateChange` deadlocks on supabase-js's auth lock. Defer with
  `setTimeout(…, 0)`.
- The dev API bridge only knew two routes; new routes fell through to static files.

## 8. Compliance gates (phase 3)

1. `jurisdictions` table: every state, **all disabled by default**, with a minimum age.
2. `geo_checks`: append-only log of every location decision (signup, entry; later deposit and
   withdrawal). `place_entry` now **requires** a fresh (≤2 min) `allow` check belonging to that
   player for an enabled state; the old function is internal and not callable even by server code.
3. Age: the stricter of home state and current location, re-checked on every entry.
4. Location source: Vercel IP geolocation headers; optional VPN/proxy detection via ipinfo
   (`IPINFO_TOKEN`, enforce with `GEO_REQUIRE_VPN_CHECK=true`). Swap in a dedicated geolocation
   provider for launch behind the same `GeoResult` shape.
5. KYC: provider adapter (`server/kyc.ts`) — Persona (hosted document + selfie, signed webhook)
   or `manual` operator review. Only decisions and a salted identity hash are stored. A unique
   index makes one verified identity approvable on one account only.
6. Devices: hashed device id per request; a device shared by accounts flags them all.
7. Operator Compliance tab: enable states + ages, ID review queue, flagged accounts (hold/unhold),
   recent location blocks.

**Testing trick:** `GEO_DEV_LOCATION=US-NJ` (ignored on Vercel) simulates location locally, so the
same browser test can prove "allowed in NJ" and "blocked in CA".

## 9. Payments (phase 4)

Migration `supabase/migrations/…_payments.sql`, server `server/payments.ts`, UI `src/components/WalletPanel.tsx`
and the operator **Payments** tab.

1. **Tables:** `payments` (one row per deposit/withdrawal, strict status flow enforced by a CHECK),
   `payment_methods` (processor tokens only — never card/account numbers), `payment_events`
   (append-only log of every verified webhook; unique `(provider, event_id)` = exactly-once),
   `provider_settlements` (the processor's settlement report, for reconciliation).
2. **Deposit flow:** `start_deposit` (location, age, self-exclusion, hold and $10–$2,500 checks) →
   processor hosted checkout → **signed webhook** → `process_payment_event` credits the ledger
   only if the payment exists, is still `created`, and the reported amount equals the amount we
   created. The browser redirect back never credits anything; the wallet polls until the webhook lands.
3. **Withdrawal flow:** `request_withdrawal` needs location + KYC approved + a method the player has
   successfully deposited with (closed loop); cash moves to `user_withdrawal_hold` → operator
   reviews with full context → approve triggers the payout → `payout.paid` webhook moves hold →
   clearing. Cancel/decline/`payout.failed` return the hold to cash.
4. **Chargeback** (`deposit.reversed`): freeze the account, block the method, claw back
   `min(available, amount)`, record the shortfall.
5. **Reconciliation:** `reconcile_payments()` compares the processor report, our payments and the
   ledger (`missing_internally`, `amount_mismatch`, `missing_at_provider`, `ledger_missing`);
   `ledger_reconcile()` checks balances vs postings. Both should be empty.
6. **Processor adapter** (`PaymentProvider`): `createCheckout`, `createPayout`, `parseWebhook`
   (verify signature, normalise events), optional `settlementReport`. The built-in **sandbox**
   processor implements it with a hosted checkout page (`/pay/sandbox`) and HMAC-signed webhooks
   (`t=…,v1=…`, 5-minute replay window), so the whole path can be tested before a real processor
   is chosen. It refuses to run on Vercel production unless explicitly allowed.

**Adding a real processor:** implement `PaymentProvider` for it in `server/payments.ts`, register
it in `providers`, map its webhook events to `deposit.succeeded | deposit.failed | deposit.reversed |
payout.paid | payout.failed`, point its webhook at `/api/pay/webhook?provider=<name>`, set
`PAYMENTS_PROVIDER=<name>` and its keys in Vercel. Test in its sandbox with the same browser script.

**Bugs found in phase 4 testing:**
- The dev API bridge built request URLs without the Host header, so redirect URLs lost the port.
  Build absolute URLs from the incoming Host (Vercel already passes full URLs).
- A row-level append-only trigger doesn't fire on an empty table — test guards after inserting
  rows, and add statement-level TRUNCATE guards too.
- In Postgres, one failed query aborts the whole transaction; use savepoints in tests that expect errors.

**Decision:** abandoned checkouts stay `created` (shown as "Not completed" after 30 minutes)
rather than being auto-failed — a processor can confirm late, and failing first would leave a
player charged but not credited. Reconciliation surfaces any late settlement.

## 10. Responsible gaming, audit log, rate limiting (phase 5)

Migrations `…_responsible_gaming_audit.sql` and `…_limit_usage_checkout_window.sql`, server
`server/rg.ts`, UI `src/pages/ResponsibleGaming.tsx`, `src/components/RealityCheck.tsx`, admin **Audit log** tab.

1. **Limits** (`player_limits`, append-only history): deposit, stake and loss limits for rolling
   24 hours, 7 days and 30 days. `set_limit` makes a stricter limit effective now and a looser one
   (or removal) effective in 24 hours; the limit in force is the newest request whose time has come.
   `enforce_limits` runs inside `start_deposit` and `place_entry`, so they're enforced in the database.
   - deposit usage = completed + charged-back deposits + checkouts opened in the last hour
   - stake usage = stakes placed; loss usage = stakes placed − everything paid back (wins, refunds)
2. **Breaks and self-exclusion** (`player_exclusions`, append-only): cool-off 1/7/30 days,
   self-exclusion 6 months/1 year/5 years/permanent (`'infinity'`). Deposits and entries stop at once;
   withdrawals stay open. A trigger on `profiles.self_exclusion_until` refuses any change that would
   shorten an active exclusion — including by an operator.
3. **Spend summary** (`spend_summary`): deposits, withdrawals, staked and won back for 24h/7d/30d/all time.
4. **Session reminders**: every N minutes (player-chosen, default 60) a check-in shows time played and
   net result since the session started (snapshot of the spend summary at session start).
5. **One-tap path**: Responsible gaming page linked from the ticket, Account, the home footer and the
   app-wide break banner; 1-800-GAMBLER help link.
6. **Audit log** (`audit_log`, append-only incl. TRUNCATE): database triggers record ledger
   transactions (deferred to commit so amounts are known), payment status changes, KYC decisions,
   limits, exclusions, account flag/age/state changes, state switches, games, lines and results, and
   location denials (every location check is also in `geo_checks`). The server adds an explicit
   `operator.<action>` row with the operator's identity for every dashboard action, and
   `exclusion.requested` for player requests. Operators browse and filter it in the Audit log tab.
7. **Rate limiting** (`hit_rate_limit`, fixed windows in an unlogged table): entries 10/min,
   deposits 5/10 min, withdrawals 5/hour, identity checks 5/hour, profile 10/hour, limits 30/hour,
   sandbox checkout 10/10 min, operator actions 120/min. Returns HTTP 429 with `Retry-After`.
   Supabase Auth applies its own limits to sign-in and sign-up.

**Found in phase 5 testing:**
- Counting open checkouts toward the deposit limit (to stop parallel checkouts exceeding it) meant an
  abandoned checkout blocked the player for the whole 30-day window. Fixed with a one-hour checkout
  window — as a new migration, because applied migrations are never edited.
- A cool-off error said "self-excluded"; messages now say "on a break or self-excluded".
- Setting a limit below what's already been used in the window blocks further play until it frees up
  — expected behaviour, worth explaining to support staff.

## 11. Operator console (phase 6)

Migration `…_operator_console.sql`, server `server/console.ts`, UI `src/pages/admin/Players.tsx`.

1. **Player lookup** (Players tab): search by email fragment or player ID → one page per player:
   identity, age, home state, ID check, flags and break status; wallet (available / held / in play);
   entries with every leg; ledger statement (each posting with account and memo); payments with
   method and reviewer; limits (current and pending) and breaks; ID-check history; devices (and how
   many other accounts share each); Supabase Auth sessions (`player_sessions`, read as JSON so Auth
   schema changes don't break it); location checks; the player's full audit trail.
   Actions: hold / remove hold, adjust balance (ledger adjustment with reason), add a case note.
2. **Force-settle a leg** (`force_settle_leg`): for a pending leg of an open entry — hit, miss or
   void — with a required reason; the entry then settles through the normal `settle_entry` (voids
   re-price). Writes `operator.force_settle_leg` with the reason.
3. **Line overrides**: edit a line from the Picks tab; placed entries keep the line they locked in
   (`entry_picks.line`), so an override never changes an existing entry. Audited as `line.changed`.
4. **Queues with reason codes**: withdrawal declines and "mark deposit failed" use standard codes
   (name mismatch, identity unverified, suspected fraud, duplicate account, responsible gaming,
   processor issue, other + note). `fail_pending_deposit` moves no money and makes a later success
   webhook be refused (it then shows in reconciliation).
5. **Operator management**: Operators card (Compliance tab) grants/revokes `app_metadata.role`.
   Bootstrap: put your email in `OPERATOR_EMAILS` in Vercel — any **confirmed** account with a listed
   email is an operator. You can't revoke yourself; emails in `OPERATOR_EMAILS` are removed there.
   Note: `user_metadata` is editable by players, so roles live only in `app_metadata`.

**Found in phase 6 testing:**
- After signing in, the login page stopped on "You're signed in" instead of continuing to the page
  the player was going to. It now redirects (setup first if unfinished).
- Some actions were audited twice (the database/console row and the generic operator row); those
  actions now write only their own detailed row.
- An action that returned no refreshed data left the Payments tab stuck on "Loading…"; every
  console action now returns the view it changes.

---

## 12. Venom & Shield lines, worldwide sign-up, native shell

Migration `…_venom_shield_and_countries.sql`.

**Venom and Shield (tiered alternate lines).** PicksArena's own take on boosted/discounted alt lines.
1. A projection has a `tier` (`standard`, `venom`, `shield`) and a `payout_factor`. Venom = a harder
   line paying more (factor above 1, at most 5). Shield = an easier line paying less (0.25 to below 1).
   A check constraint keeps tier and factor consistent; one open line per player/stat/tier.
2. Tiered picks are **More only** and **Power Play only** (enforced in `place_entry_unchecked` and in
   `validateLineup` in the app, with matching messages).
3. Payout = power table × product of the factors, rounded to 2 decimals, capped at 1000×
   (`entry_multiplier`). Each pick snapshots its factor (`entry_picks.payout_factor`), so later edits
   never change a placed entry. If a leg pushes or is voided, its factor drops out with it.
4. A player can still only have one pick per player in an entry, so a Venom line is an alternative
   to the standard line, not an add-on.
5. **Automatic Venom lines.** When an operator posts a standard line, the Admin form (switch "Auto
   Venom line", on by default) also posts the Venom alternate: `autoVenom(line)` in
   `src/shared/admin.ts` moves the line up about 15% (at least one whole step, so .5 lines stay .5)
   and sets the factor to `1 + 2.5 × step / line`, rounded to 0.05, between 1.25 and 3.
   Examples: 20.5 → 23.5 at ×1.35; 6.5 → 7.5 at ×1.4; 0.5 → 1.5 at ×3. Skipped if a Venom line already
   exists. Operators can still post Venom/Shield lines by hand with their own factor.
   The demo board generates Venom and Shield alternates on its own.
6. UI: purple Venom / teal Shield cards with a "Venom ×1.5" flag and a single "More" button;
   "Venom & Shield" filter chip; slip and ticket show the factored multiplier; rules on How to play.

**Worldwide registration.**
1. `countries` table: all 250 ISO 3166 codes, **every one off by default** (fail closed), `min_age` 18
   (US 21). Enable a country only where you hold a licence: Admin → Compliance → Countries.
2. US play is still decided state by state through `jurisdictions`; other countries by the country row
   (`place_enabled(country, region)`). The age rule is the stricter of home and current location
   (`min_age_for_place`). Geofence decisions now say `country_not_eligible` or `state_not_eligible`.
3. Sign-up asks for the country (pre-filled from the browser language); state only for the US.
   `profiles.country` defaults to `US`. Currency stays USD for now.

**Native look and feel.**
- `src/components/NativeDialog.tsx`: `askConfirm` / `askPrompt` replace `window.confirm/prompt`;
  bottom action sheet on phones, centred dialog from 720px.
- `src/components/NativeShell.tsx`: large page titles collapse into the top bar on scroll;
  tab switches use the View Transitions API (skipped with reduced motion); pull-to-refresh on touch
  devices reloads the board and the account (`refreshAll` in the store).
- Skeleton cards while the real-money board loads.

**Found in testing:** a leftover demo Specials list made the board open on Specials (tests now
open `/board?sport=NBA`); started demo games disable their cards (tests skip them).

**On copying another operator's lines:** we do not scrape or mirror a competitor's board (their
terms forbid it, the lines are their work product, and it is a legal risk for a licensed real-money
operator). For live data, use a licensed sports-data feed (e.g. SportsDataIO, Sportradar, Genius
Sports) behind an import adapter that creates games and standard lines; Venom lines then follow
automatically via `autoVenom`.

---

## 13. Live data from TheSportsDB

Files: `server/sportsdb.ts` (client), `server/feed.ts` (scores endpoint + importer), `api/board.ts` (`?view=scores`, sharing the function because the Hobby plan allows 12),
`src/components/Scores.tsx`, migration `…_feed_state.sql`.

1. **What the feed gives.** TheSportsDB (free key `123`): real schedules, teams, badges, colours and
   final scores. Free tier limits: about 3 events per league per day, no in-game scores. A premium
   key in `THESPORTSDB_KEY` lifts the limits and turns on the v2 livescore overlay automatically.
   It has **no player stats or projections**, so it cannot create or grade player lines.
2. **Scores strip.** `GET /api/board?view=scores` returns yesterday/today/tomorrow for NBA, NFL, NHL, MLB,
   Premier League and college football, cached 60 s in the function and at the CDN. The strip on Home
   and Board refreshes every minute and when the app returns to the foreground. Attribution links back
   to TheSportsDB.
3. **Game import (real money).** `syncGames()` imports upcoming NBA/NFL games (`external_id =
   'tsdb:<id>'`) with team abbreviations, names and colours from `lookupteam`, then keeps start times,
   scores and status current (`in_progress`, `final`; cancelled games go through `void_game`, which
   refunds or re-prices entries). It never creates games that already started.
4. **When it runs.** `maybeSync()` runs from `/api/board` at most every 5 minutes, coordinated by
   `claim_feed_run` in Postgres so concurrent visitors don't all call the feed; it never delays the
   board by more than 4 s. Admin → Games → **Sync games now** forces a run.
5. **Still manual.** Operators post player lines (Venom follows automatically) and enter final player
   stats to grade. Automating that needs a feed with player data (e.g. SportsDataIO, Sportradar).

**Decided:** don't scrape or mirror a competitor's lines; use a licensed or open data feed.

---

## Pre-launch: reset the database to a clean ledger

Testing writes sandbox transactions to the append-only ledger, which can't be deleted row by row
(by design). Before launch, while there are no real players, reset everything:

1. In Supabase → **Authentication → Users**, delete the QA/test users (only test accounts exist pre-launch).
2. Supabase → **SQL editor**, run: `drop schema public cascade; create schema public;
   grant usage on schema public to anon, authenticated, service_role;`
   then `delete from supabase_migrations.schema_migrations;`.
3. Re-apply every file in `supabase/migrations/` in order (Management API or the SQL editor) and
   record each version in `supabase_migrations.schema_migrations`.
4. Re-enable your licensed states and countries in **Admin → Compliance**; re-flag your operator account
   (`app_metadata.role = 'operator'`).
5. Run `select * from ledger_reconcile(); select * from reconcile_payments();` — both empty.

Never do this after launch. From launch on, corrections are new ledger transactions, never edits.

---

## Decisions log

| Decision | Why |
|---|---|
| Money rules in Postgres functions, not app code | One enforcement point; no app bug can bypass them |
| Append-only double-entry ledger with idempotency keys | Every dollar traceable; retries can't double-post |
| Integer cents everywhere | No floating-point money |
| Lines snapshotted per pick | Later line edits never change placed entries |
| Whole-number lines only in real money | Pushes are settled there; the demo has no push rules |
| Operator = server-set role, not a shared password | Spec: role checked server-side |
| Every state off by default; deny when location unknown | Fail closed |
| Location check row required by `place_entry` / money functions | Database enforces the geofence |
| Age = stricter of home state and current location | Covers travellers and residents |
| KYC stores decision + salted identity hash only | Spec: store the decision, not documents |
| Withdrawals closed-loop to deposited methods | Limits fraud and money laundering |
| Credit only from signed webhooks with matching amount | Never trust redirects or client amounts |
| Sandbox processor instead of guessing a real processor's API | Full path testable now; real one drops in behind the adapter |
| Abandoned checkouts not auto-failed | Late confirmations must still credit |
| Stricter limits now, looser after 24 hours | Industry standard; stops impulsive loosening |
| Exclusions extend-only, enforced by trigger | A break must not be undone, even by staff |
| Withdrawals allowed during breaks | Players must always be able to take their money out |
| Audit via triggers + explicit operator rows | Captures every change, plus who made it |
| Rate limits in Postgres, failing open | No extra service; a limiter outage can't lock everyone out |
| New migration for fixes, never edit applied ones | Every environment replays the same history |
| Roles only in `app_metadata`, bootstrap via `OPERATOR_EMAILS` | Players can edit `user_metadata`; the owner can always get in without SQL |
| Force-settle per leg, not per entry | Keeps settlement in one code path; the entry re-prices normally |
| Reason codes for declines and failures | Consistent decisions and reportable outcomes |
| Operators can't revoke themselves | Avoids locking the house out |
| TheSportsDB for schedules and scores, run lazily from the board | Free, no extra scheduler; lines stay operator-set because the feed has no player data |
| Venom/Shield as a factor on the power table, capped at 1000× | One payout formula; the factor is snapshotted per pick |
| Tiered picks More-only and Power-only | No cheap "Less on the harder line" arbitrage; flex tables stay simple |
| Venom lines generated by a fixed formula | Consistent, explainable pricing; operators can still hand-set |
| Countries off by default, US still per state | Fail closed; each market needs its own licence |
| No scraping of competitors' boards | Terms of service, IP and licensing risk; use a licensed data feed |

---

## Working in a sandboxed cloud session (what to expect)

- Outbound hosts are allow-listed. New hosts (e.g. `<ref>.supabase.co`) need approval.
- API keys go through the secure credential form, which injects them via the proxy — never paste
  keys in chat or files. Tools that need a key get a dummy value (`--token proxyinjectedplaceholder000`).
- Node's `fetch` needs `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<bundle> NO_PROXY=localhost,127.0.0.1`.
- Playwright needs `proxy: { server: HTTPS_PROXY, bypass: '<-loopback>,localhost,127.0.0.1' }`
  to reach external hosts while keeping localhost direct.
- Creating cloud resources (stores, projects) may be blocked by session permissions; the user then
  does it in the dashboard.

## Reusing this for a similar project — checklist

1. Write the product loop as a play-money prototype with pure, tested rule functions.
2. Decide jurisdiction, licence status and providers **before** writing real-money code.
3. Design the ledger first: accounts, transaction kinds, idempotency keys, append-only, reconcile.
4. Put every money rule in database functions; expose them only to the server role; RLS everything.
5. Test against real Postgres, including concurrency and replays. Smoke-test live with rollback.
6. Gate entries in the database on location, age and account status; log every decision.
7. Keep providers (KYC, geolocation, payments) behind adapters; build against sandboxes.
8. Never trust the client: it sends intent ("these picks, this stake"); the server computes money.
9. Payments: hosted checkout + signed webhooks only; exactly-once event log; closed-loop
   withdrawals with operator review; chargeback freeze/claw-back; reconciliation against the
   processor's report. Build against a sandbox processor first.
10. Responsible gaming: limits (stricter now, looser after 24h), breaks and self-exclusion that
   can't be shortened, spend summary, session reminders, help line — all enforced in the database.
   Audit everything append-only; rate-limit every money and account endpoint.
11. Operator console: one page per player (money, play, identity, devices, sessions, audit), case
   notes, holds, adjustments with reasons, per-leg force-settle, line overrides that never touch
   placed entries, reason codes, and operator management with a bootstrap path.
12. Before going public: reset the pre-launch database, licensed states enabled, KYC +
   geolocation + payment providers live, responsible-gaming limits, audit log, custom SMTP,
   Vercel protection off.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | Vercel + `.env.local` | Browser Supabase client (public) |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Vercel (sensitive) + `.env.local` | Server database access |
| `KYC_PROVIDER` | Vercel | `persona` or `manual`; unset = identity checks off |
| `PERSONA_API_KEY`, `PERSONA_TEMPLATE_ID`, `PERSONA_WEBHOOK_SECRET` | Vercel | Persona integration |
| `KYC_HASH_SALT` | Vercel | Salt for identity fingerprints (set once, never change) |
| `IPINFO_TOKEN`, `GEO_REQUIRE_VPN_CHECK` | Vercel | VPN/proxy detection |
| `GEO_DEV_LOCATION` | local only | Simulate a location, e.g. `US-NJ` |
| `OPERATOR_EMAILS` | Vercel | Comma-separated emails that are operators once their account email is confirmed |
| `THESPORTSDB_KEY` | Vercel (optional) | TheSportsDB premium key; without it the free key `123` is used (no in-game scores) |
| `PAYMENTS_PROVIDER` | Vercel | `sandbox` (testing) or a real processor; unset = deposits/withdrawals closed |
| `PAYMENTS_SANDBOX_SECRET` | Vercel | Webhook signing secret for the sandbox (local dev has a default) |
| `PAYMENTS_SANDBOX_ALLOW_PRODUCTION` | Vercel | `true` only for pre-launch testing behind Vercel protection |
| `ADMIN_PASSWORD` | demo only | Legacy dashboard password when Supabase isn't configured |

## Commands

```bash
npm run dev                      # app + /api on http://localhost:5173 (reads .env.local)
npm test                         # unit tests (database tests skip without a database)
PA_TEST_PG_HOST=/var/lib/postgresql/pa PA_TEST_PG_PORT=54329 npm test   # + database tests
npm run build                    # type-check app and server, build PWA
npx vercel@48.10.0 deploy --prod --yes --scope <team>                    # deploy
```
