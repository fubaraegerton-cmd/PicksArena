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
| 10 | Responsible gaming + audit (phase 5) | Limits, self-exclusion, audit log, rate limits *(next)* |

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
4. Re-enable your licensed states in **Admin → Compliance**; re-flag your operator account
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
10. Before going public: reset the pre-launch database, licensed states enabled, KYC +
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
