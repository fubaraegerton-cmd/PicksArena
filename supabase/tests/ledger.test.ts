/**
 * Integration tests for the money core (ledger, entries, settlement) against a real Postgres.
 *
 * Run with a throwaway Postgres you control:
 *   PA_TEST_PG_HOST=/path/to/socket PA_TEST_PG_PORT=5432 npm test
 * The suite creates and drops its own database. It is skipped when PA_TEST_PG_HOST is unset.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';

const HOST = process.env.PA_TEST_PG_HOST;
const PORT = Number(process.env.PA_TEST_PG_PORT ?? 5432);
const USER = process.env.PA_TEST_PG_USER ?? 'postgres';
const DB = 'pa_ledger_test';

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

let db: pg.Pool;

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];

async function user() {
  const { id } = (await one<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [`${randomUUID()}@test.local`]))!;
  await q(`insert into public.profiles (id, dob, state) values ($1, '1990-01-01', 'NJ')`, [id]);
  return id;
}
async function game(minutesFromNow = 60, home = randomUUID().slice(0, 3), away = randomUUID().slice(0, 3)) {
  return (await one<{ id: string }>(
    `insert into public.games (sport, home_team, away_team, starts_at) values ('NBA', $1, $2, now() + make_interval(mins => $3)) returning id`,
    [home, away, minutesFromNow],
  ))!.id;
}
async function line(gameId: string, team: string, line: number, player = randomUUID()) {
  return (await one<{ id: string }>(
    `insert into public.projections (game_id, slate_date, player_id, player_name, team, position, stat_type, line)
     values ($1, current_date, $2, 'Test Player', $3, 'G', 'Points', $4) returning id`,
    [gameId, player, team, line],
  ))!.id;
}
const deposit = (u: string, cents: number, key = `dep:${randomUUID()}`) =>
  q(`select public.credit_deposit($1, $2, 'test-payment', $3)`, [u, cents, key]);
/** Logs a location check, as the server does before every entry. */
async function geo(u: string, decision: 'allow' | 'deny' = 'allow', region = 'NJ', ageMinutes = 0) {
  return (await one<{ id: string }>(
    `insert into public.geo_checks (user_id, action, region, country, provider, decision, created_at)
     values ($1, 'entry', $2, 'US', 'test', $3, now() - make_interval(mins => $4)) returning id`,
    [u, region, decision, ageMinutes],
  ))!.id;
}
const place = async (u: string, picks: { id: string; d: 'more' | 'less' }[], stake: number, key = `ent:${randomUUID()}`, geoId?: string) =>
  one<{ id: string; status: string; multiplier: string; potential_payout_cents: string }>(
    `select * from public.place_entry($1, $2::jsonb, $3, $4, $5)`,
    [u, JSON.stringify(picks.map((p) => ({ projection_id: p.id, direction: p.d }))), stake, key, geoId ?? (await geo(u))],
  );
const grade = (proj: string, v: number) => q(`select public.grade_projection($1, $2)`, [proj, v]);
const wallet = async (u: string) => {
  const r = await one<{ available_cents: string; in_play_cents: string }>(`select * from public.wallets where user_id = $1`, [u]);
  return { available: Number(r?.available_cents ?? 0), inPlay: Number(r?.in_play_cents ?? 0) };
};
const entry = (id: string) => one<{ status: string; payout_cents: string; settled_legs: number; settled_multiplier: string | null }>(
  `select * from public.entries where id = $1`, [id]);
const reconcile = () => q(`select * from public.ledger_reconcile()`);
const houseGaming = async () =>
  Number((await one<{ b: string }>(`select coalesce(b.balance_cents,0) as b from public.ledger_accounts a left join public.ledger_balances b on b.account_id=a.id where a.kind='house_gaming'`))?.b ?? 0);

/** A ready-made slate: two teams in one game, plus a second game, each with several lines. */
async function slate() {
  const g1 = await game(90, 'HAR', 'DSR');
  const g2 = await game(120, 'MET', 'CAP');
  return {
    g1,
    g2,
    a: await line(g1, 'HAR', 24.5),
    b: await line(g1, 'DSR', 10.5),
    c: await line(g2, 'MET', 7.5),
    d: await line(g2, 'CAP', 20), // whole-number line: can push
    e: await line(g1, 'HAR', 5.5),
    f: await line(g2, 'MET', 2.5),
  };
}

describe.skipIf(!HOST)('money core (Postgres)', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ host: HOST, port: PORT, user: USER, database: 'postgres' });
    await admin.connect();
    await admin.query(`drop database if exists ${DB} with (force)`);
    await admin.query(`create database ${DB}`);
    await admin.end();
    db = new pg.Pool({ host: HOST, port: PORT, user: USER, database: DB, max: 6 });
    await db.query(read('tests/supabase_shim.sql'));
    for (const m of ['20261119000001_ledger_and_entries', '20261119000002_slate_details', '20261120000003_compliance_gates', '20261121000004_payments', '20261122000005_responsible_gaming_audit', '20261122000006_limit_usage_checkout_window', '20261123000007_operator_console', '20261124000008_venom_shield_and_countries'])
      await db.query(read(`migrations/${m}.sql`));
    await db.query(`update public.jurisdictions set enabled = true where state in ('NJ', 'PA')`);
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    expect(await reconcile()).toEqual([]);
  });

  describe('ledger integrity', () => {
    it('deposits credit the wallet and a repeated webhook does not double-credit', async () => {
      const u = await user();
      await deposit(u, 5000, 'dep:webhook-123');
      await deposit(u, 5000, 'dep:webhook-123');
      expect((await wallet(u)).available).toBe(5000);
      expect(await reconcile()).toEqual([]);
    });

    it('rejects unbalanced transactions', async () => {
      const u = await user();
      const acct = (await one<{ id: string }>(`select public.ledger_account('user_cash', $1) as id`, [u]))!.id;
      await expect(
        q(`select public.ledger_post('adjustment', $1, $2::jsonb, $3)`, [
          `bad:${randomUUID()}`,
          JSON.stringify([{ account: acct, amount: 100 }]),
          u,
        ]),
      ).rejects.toThrow(/unbalanced/);
      expect((await wallet(u)).available).toBe(0);
    });

    it('is append-only', async () => {
      const u = await user();
      await deposit(u, 1000);
      await expect(q(`update public.ledger_postings set amount_cents = 999999`)).rejects.toThrow(/append-only/);
      await expect(q(`delete from public.ledger_transactions`)).rejects.toThrow(/append-only/);
      await expect(q(`truncate public.ledger_postings cascade`)).rejects.toThrow(/append-only/);
    });

    it('never lets a player balance go negative', async () => {
      const u = await user();
      await deposit(u, 500);
      await expect(q(`select public.operator_adjust($1, -501, 'test overdraw', $2)`, [u, `adj:${randomUUID()}`])).rejects.toThrow(
        /insufficient_funds/,
      );
      expect((await wallet(u)).available).toBe(500);
    });
  });

  describe('placing entries', () => {
    it('moves the stake into escrow and prices it server-side', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const e = (await place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }, { id: s.c, d: 'more' }], 2_000))!;
      expect(e.status).toBe('open');
      expect(Number(e.multiplier)).toBe(5);
      expect(Number(e.potential_payout_cents)).toBe(10_000);
      expect(await wallet(u)).toEqual({ available: 8_000, inPlay: 2_000 });
    });

    it('is idempotent on the client key', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const picks = [{ id: s.a, d: 'more' as const }, { id: s.b, d: 'less' as const }];
      const first = await place(u, picks, 1_000, 'ent:same-key-1');
      const second = await place(u, picks, 1_000, 'ent:same-key-1');
      expect(second!.id).toBe(first!.id);
      expect((await wallet(u)).available).toBe(9_000);
    });

    it('rejects stakes the player cannot cover, writing nothing', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 500);
      await expect(place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 600)).rejects.toThrow(/insufficient_funds/);
      expect(await one(`select count(*)::int as n from public.entries where user_id = $1`, [u])).toEqual({ n: 0 });
      expect(await wallet(u)).toEqual({ available: 500, inPlay: 0 });
    });

    it('enforces pick rules on the server', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 100_000);
      await expect(place(u, [{ id: s.a, d: 'more' }], 1_000)).rejects.toThrow(/pick_count_out_of_range/);
      await expect(place(u, [{ id: s.a, d: 'more' }, { id: s.e, d: 'less' }], 1_000)).rejects.toThrow(/needs_two_teams/);
      await expect(place(u, [{ id: s.a, d: 'more' }, { id: s.a, d: 'less' }], 1_000)).rejects.toThrow(/duplicate_projection/);
      const g = await game(90, 'AAA', 'BBB');
      // Same player, two different stats: only one pick per player is allowed.
      const p1 = await line(g, 'AAA', 10.5, 'same-player');
      const p2 = (await one<{ id: string }>(
        `insert into public.projections (game_id, slate_date, player_id, player_name, team, position, stat_type, line)
         values ($1, current_date, 'same-player', 'Test Player', 'AAA', 'G', 'Assists', 3.5) returning id`,
        [g],
      ))!.id;
      await expect(place(u, [{ id: p1, d: 'more' }, { id: p2, d: 'less' }, { id: s.b, d: 'more' }], 1_000)).rejects.toThrow(
        /one_pick_per_player/,
      );
      await expect(place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 50)).rejects.toThrow(/stake_below_minimum/);
      await expect(place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 100_001)).rejects.toThrow(/stake_above_maximum/);
    });

    it('locks each line at its own game start', async () => {
      const u = await user();
      await deposit(u, 10_000);
      const started = await game(-1, 'OLD', 'GME');
      const later = await game(60, 'NEW', 'GMS');
      const x = await line(started, 'OLD', 12.5);
      const y = await line(later, 'NEW', 8.5);
      await expect(place(u, [{ id: x, d: 'more' }, { id: y, d: 'more' }], 1_000)).rejects.toThrow(/game_started/);
      await q(`update public.games set status = 'in_progress' where id = $1`, [later]);
      const z = await line(await game(60, 'ZZZ', 'YYY'), 'ZZZ', 4.5);
      await expect(place(u, [{ id: y, d: 'more' }, { id: z, d: 'more' }], 1_000)).rejects.toThrow(/game_started/);
      expect((await wallet(u)).available).toBe(10_000);
    });

    it('blocks self-excluded players', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      await q(`update public.profiles set self_exclusion_until = now() + interval '30 days' where id = $1`, [u]);
      await expect(place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 1_000)).rejects.toThrow(/self_excluded/);
    });

    it('serializes concurrent entries so a balance can never be spent twice', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 1_000);
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 600)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await wallet(u)).toEqual({ available: 400, inPlay: 600 });
    });
  });

  describe('grading and settlement', () => {
    it('pays a winning entry automatically once every leg is final', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const e = (await place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 1_000))!;
      await grade(s.a, 30);
      expect((await entry(e.id))!.status).toBe('open');
      await grade(s.b, 8);
      const done = (await entry(e.id))!;
      expect(done.status).toBe('won');
      expect(Number(done.payout_cents)).toBe(3_000);
      expect(await wallet(u)).toEqual({ available: 12_000, inPlay: 0 });
    });

    it('settles a loss to the house', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const before = await houseGaming();
      const e = (await place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 1_000))!;
      await grade(s.a, 30);
      await grade(s.b, 11);
      expect((await entry(e.id))!.status).toBe('lost');
      expect(await wallet(u)).toEqual({ available: 9_000, inPlay: 0 });
      expect((await houseGaming()) - before).toBe(1_000);
    });

    it('re-prices on the remaining legs when a leg pushes', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      // 3 legs, one pushes (line 20, final 20) -> paid as a 2-pick at 3x
      const e = (await place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }, { id: s.d, d: 'more' }], 1_000))!;
      await grade(s.d, 20);
      await grade(s.a, 25);
      await grade(s.b, 3);
      const done = (await entry(e.id))!;
      expect(done.status).toBe('won');
      expect(done.settled_legs).toBe(2);
      expect(Number(done.settled_multiplier)).toBe(3);
      expect(Number(done.payout_cents)).toBe(3_000);
    });

    it('refunds when fewer than two legs remain', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const e = (await place(u, [{ id: s.b, d: 'more' }, { id: s.d, d: 'less' }], 1_000))!;
      await q(`select public.void_projection($1)`, [s.b]); // player ruled out
      await grade(s.d, 20); // push
      const done = (await entry(e.id))!;
      expect(done.status).toBe('refunded');
      expect(await wallet(u)).toEqual({ available: 10_000, inPlay: 0 });
    });

    it('a miss loses even when other legs push', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const e = (await place(u, [{ id: s.a, d: 'more' }, { id: s.d, d: 'less' }], 1_000))!;
      await grade(s.d, 20);
      await grade(s.a, 10);
      expect((await entry(e.id))!.status).toBe('lost');
    });

    it('pays a 6-pick at 40x', async () => {
      const u = await user();
      await deposit(u, 10_000);
      const g1 = await game(90, 'T1A', 'T1B');
      const g2 = await game(90, 'T2A', 'T2B');
      const g3 = await game(90, 'T3A', 'T3B');
      const ids = [
        await line(g1, 'T1A', 1.5), await line(g1, 'T1B', 1.5),
        await line(g2, 'T2A', 1.5), await line(g2, 'T2B', 1.5),
        await line(g3, 'T3A', 1.5), await line(g3, 'T3B', 1.5),
      ];
      const e = (await place(u, ids.map((id) => ({ id, d: 'more' as const })), 500))!;
      for (const id of ids) await grade(id, 2);
      const done = (await entry(e.id))!;
      expect(done.status).toBe('won');
      expect(Number(done.payout_cents)).toBe(20_000);
    });

    it('treats a re-delivered result as a no-op and refuses a conflicting one', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      await place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 1_000);
      await grade(s.a, 30);
      await grade(s.b, 8);
      await grade(s.b, 8);
      expect((await wallet(u)).available).toBe(12_000);
      await expect(grade(s.b, 12)).rejects.toThrow(/already_graded/);
    });

    it('grades against the line the player locked in, not a later override', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const e = (await place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 1_000))!; // a: more than 24.5
      await q(`update public.projections set line = 31.5 where id = $1`, [s.a]);
      await grade(s.a, 28);
      await grade(s.b, 8);
      expect((await entry(e.id))!.status).toBe('won');
    });

    it('voiding a game refunds or re-prices every affected entry', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const two = (await place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 1_000))!; // both on g1
      const three = (await place(u, [{ id: s.a, d: 'more' }, { id: s.c, d: 'more' }, { id: s.f, d: 'less' }], 1_000))!;
      await q(`select public.void_game($1)`, [s.g1]);
      expect((await entry(two.id))!.status).toBe('refunded');
      expect((await entry(three.id))!.status).toBe('open');
      await grade(s.c, 9);
      await grade(s.f, 1);
      const done = (await entry(three.id))!;
      expect(done.status).toBe('won');
      expect(Number(done.payout_cents)).toBe(3_000);
    });
  });

  describe('access control', () => {
    async function asPlayer<T>(uid: string, fn: (c: pg.PoolClient) => Promise<T>) {
      const c = await db.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
        await c.query('set local role authenticated');
        return await fn(c);
      } finally {
        await c.query('rollback');
        c.release();
      }
    }

    it('players see only their own entries, ledger and wallet', async () => {
      const s = await slate();
      const a = await user();
      const b = await user();
      await deposit(a, 5_000);
      await deposit(b, 7_000);
      await place(a, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 1_000);
      await place(b, [{ id: s.a, d: 'less' }, { id: s.b, d: 'more' }], 1_000);
      const seen = await asPlayer(a, async (c) => ({
        entries: (await c.query('select user_id from public.entries')).rows,
        txns: (await c.query('select user_id from public.ledger_transactions')).rows,
        wallets: (await c.query('select user_id, available_cents from public.wallets')).rows,
        lines: (await c.query('select count(*)::int as n from public.projections')).rows[0].n,
      }));
      expect(seen.entries.every((r) => r.user_id === a)).toBe(true);
      expect(seen.entries).toHaveLength(1);
      expect(seen.txns.every((r) => r.user_id === a)).toBe(true);
      expect(seen.wallets).toEqual([{ user_id: a, available_cents: '4000' }]);
      expect(seen.lines).toBeGreaterThan(0);
    });

    it('players cannot write or call money functions directly', async () => {
      const s = await slate();
      const a = await user();
      await expect(asPlayer(a, (c) => c.query(`select public.credit_deposit($1, 100000, 'x', 'dep:self-credit')`, [a]))).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        asPlayer(a, (c) => c.query(`select public.place_entry($1, '[]'::jsonb, 100, 'ent:direct-call', 1)`, [a])),
      ).rejects.toThrow(/permission denied/);
      await expect(asPlayer(a, (c) => c.query(`insert into public.entries (user_id, idempotency_key, stake_cents, pick_count, multiplier, potential_payout_cents) values ($1, 'x', 1, 2, 3, 3)`, [a]))).rejects.toThrow(/permission denied/);
      await expect(asPlayer(a, (c) => c.query(`update public.projections set line = 0.5 where id = $1`, [s.a]))).rejects.toThrow(/permission denied/);
    });
  });

  describe('phase 3: location, age and identity gates', () => {
    const picks = (s: Awaited<ReturnType<typeof slate>>) => [{ id: s.a, d: 'more' as const }, { id: s.b, d: 'less' as const }];

    it('refuses entries without a fresh allowed location check for that player', async () => {
      const s = await slate();
      const u = await user();
      const other = await user();
      await deposit(u, 10_000);
      await expect(place(u, picks(s), 1_000, undefined, '999999999')).rejects.toThrow(/location_check_required/);
      await expect(place(u, picks(s), 1_000, undefined, await geo(u, 'deny'))).rejects.toThrow(/location_check_required/);
      await expect(place(u, picks(s), 1_000, undefined, await geo(u, 'allow', 'NJ', 3))).rejects.toThrow(/location_check_required/);
      await expect(place(u, picks(s), 1_000, undefined, await geo(other))).rejects.toThrow(/location_check_required/);
      await expect(place(u, picks(s), 1_000, undefined, await geo(u, 'allow', 'CA'))).rejects.toThrow(/location_not_eligible/);
      expect((await wallet(u)).available).toBe(10_000);
      expect((await place(u, picks(s), 1_000))!.status).toBe('open');
    });

    it('applies the stricter minimum age of home state and current location', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const twenty = new Date(Date.now() - 20.5 * 365.25 * 864e5).toISOString().slice(0, 10);
      await q(`update public.profiles set dob = $2, state = 'PA' where id = $1`, [u, twenty]);
      await q(`update public.jurisdictions set min_age = 18 where state = 'PA'`);
      await q(`update public.jurisdictions set min_age = 21 where state = 'NJ'`);
      await expect(place(u, picks(s), 1_000)).rejects.toThrow(/under_age/); // located in NJ (21+)
      expect((await place(u, picks(s), 1_000, undefined, await geo(u, 'allow', 'PA')))!.status).toBe('open');
      await q(`update public.jurisdictions set min_age = 21 where state = 'PA'`);
    });

    it('blocks flagged accounts and players without a completed profile', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      await q(`update public.profiles set flags = flags || '{"blocked": true}' where id = $1`, [u]);
      await expect(place(u, picks(s), 1_000)).rejects.toThrow(/account_blocked/);
      const v = await user();
      await q(`update public.profiles set dob = null where id = $1`, [v]);
      await expect(place(v, picks(s), 1_000)).rejects.toThrow(/profile_required/);
    });

    it('server code cannot bypass the geofence through the internal function', async () => {
      const c = await db.connect();
      try {
        await c.query('begin');
        await c.query('set local role service_role');
        await expect(c.query(`select public.place_entry_unchecked(gen_random_uuid(), '[]'::jsonb, 100, 'ent:bypass-attempt')`)).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await c.query('rollback');
        c.release();
      }
    });

    it('logs location checks permanently', async () => {
      const u = await user();
      await geo(u);
      await expect(q(`delete from public.geo_checks where user_id = $1`, [u])).rejects.toThrow(/append-only/);
      await expect(q(`update public.geo_checks set decision = 'allow' where user_id = $1`, [u])).rejects.toThrow(/append-only/);
    });

    it('approves one verified identity on one account only', async () => {
      const a = await user();
      const b = await user();
      const rec = async (u: string) =>
        (await one<{ id: string }>(`insert into public.kyc_records (user_id, provider, provider_ref, status) values ($1, 'test', $2, 'pending') returning id`, [u, randomUUID()]))!.id;
      const ra = await rec(a);
      const rb = await rec(b);
      expect((await one<{ s: string }>(`select public.set_kyc_decision($1, 'approved', null, 'same-person-hash', 'test') as s`, [ra]))!.s).toBe('approved');
      expect((await one<{ s: string }>(`select public.set_kyc_decision($1, 'approved', null, 'same-person-hash', 'test') as s`, [rb]))!.s).toBe('rejected');
      expect(await one(`select kyc_status, flags->>'duplicate_identity' as dup from public.profiles where id = $1`, [b])).toEqual({ kyc_status: 'rejected', dup: 'true' });
      expect(await one(`select kyc_status from public.profiles where id = $1`, [a])).toEqual({ kyc_status: 'approved' });
      await expect(q(`select public.set_kyc_decision($1, 'rejected', 'x', null, 'test')`, [ra])).rejects.toThrow(/kyc_already_decided/);
    });

    it('flags every account that shares a device', async () => {
      const a = await user();
      const b = await user();
      const hash = `dev-${randomUUID()}`;
      expect((await one<{ s: boolean }>(`select public.record_device($1, $2) as s`, [a, hash]))!.s).toBe(false);
      expect((await one<{ s: boolean }>(`select public.record_device($1, $2) as s`, [b, hash]))!.s).toBe(true);
      const flags = await q<{ f: string }>(`select flags->>'shared_device' as f from public.profiles where id = any($1)`, [[a, b]]);
      expect(flags.map((r) => r.f)).toEqual(['true', 'true']);
    });
  });

  describe('phase 4: deposits, withdrawals, webhooks, reconciliation', () => {
    async function geoFor(u: string, action: 'deposit' | 'withdrawal', region = 'NJ') {
      return (await one<{ id: string }>(
        `insert into public.geo_checks (user_id, action, region, country, provider, decision) values ($1, $2, $3, 'US', 'test', 'allow') returning id`,
        [u, action, region],
      ))!.id;
    }
    async function startDeposit(u: string, cents: number) {
      const p = (await one<{ id: string }>(`select * from public.start_deposit($1, $2, 'sandbox', $3, $4)`, [u, cents, `dep:${randomUUID()}`, await geoFor(u, 'deposit')]))!;
      const ref = `sbx_${randomUUID()}`;
      await q(`select public.set_payment_ref($1, $2)`, [p.id, ref]);
      return { id: p.id, ref };
    }
    const event = (type: string, ref: string, cents: number | null, extra: { eventId?: string; token?: string; reason?: string } = {}) =>
      one<{ r: string }>(
        `select public.process_payment_event('sandbox', $1, $2, $3, $4, '{}'::jsonb, $5, 'card', 'Visa •••• 4242', null, $6) as r`,
        [extra.eventId ?? `evt_${randomUUID()}`, type, ref, cents, extra.token ?? null, extra.reason ?? null],
      ).then((x) => x!.r);
    const status = async (id: string) => (await one<{ status: string; failure_reason: string | null }>(`select status, failure_reason from public.payments where id = $1`, [id]))!;
    async function fundedVerified(cents = 10_000) {
      const u = await user();
      await q(`update public.profiles set kyc_status = 'approved' where id = $1`, [u]);
      const d = await startDeposit(u, cents);
      const token = `tok_${randomUUID()}`;
      expect(await event('deposit.succeeded', d.ref, cents, { token })).toBe('credited');
      const method = (await one<{ id: string }>(`select id from public.payment_methods where provider_token = $1`, [token]))!.id;
      return { u, method, deposit: d };
    }
    const withdraw = async (u: string, method: string, cents: number) =>
      (await one<{ id: string; status: string }>(`select * from public.request_withdrawal($1, $2, $3, $4, $5)`, [u, cents, method, `wd:${randomUUID()}`, await geoFor(u, 'withdrawal')]))!;

    it('credits a deposit only from a verified provider event, exactly once', async () => {
      const u = await user();
      const d = await startDeposit(u, 5_000);
      expect((await wallet(u)).available).toBe(0); // created ≠ paid
      expect(await event('deposit.succeeded', d.ref, 5_000, { eventId: 'evt_dup_1', token: `tok_${randomUUID()}` })).toBe('credited');
      expect(await event('deposit.succeeded', d.ref, 5_000, { eventId: 'evt_dup_1' })).toBe('duplicate');
      expect(await event('deposit.succeeded', d.ref, 5_000)).toBe('already_applied');
      expect((await wallet(u)).available).toBe(5_000);
      expect((await status(d.id)).status).toBe('succeeded');
    });

    it('refuses to credit when the provider amount differs from the deposit created', async () => {
      const u = await user();
      const d = await startDeposit(u, 5_000);
      expect(await event('deposit.succeeded', d.ref, 500_000)).toBe('amount_mismatch');
      expect((await wallet(u)).available).toBe(0);
      expect((await status(d.id)).status).toBe('failed');
    });

    it('records events for unknown payments without moving money', async () => {
      expect(await event('deposit.succeeded', 'sbx_not_ours', 5_000)).toBe('unknown_payment');
    });

    it('gates deposits on location, limits, self-exclusion and holds', async () => {
      const u = await user();
      await expect(q(`select public.start_deposit($1, 5000, 'sandbox', 'dep:no-geo-1', 99999999)`, [u])).rejects.toThrow(/location_check_required/);
      await expect(q(`select public.start_deposit($1, 500, 'sandbox', 'dep:too-small', $2)`, [u, await geoFor(u, 'deposit')])).rejects.toThrow(/deposit_below_minimum/);
      await expect(q(`select public.start_deposit($1, 300000, 'sandbox', 'dep:too-big', $2)`, [u, await geoFor(u, 'deposit')])).rejects.toThrow(/deposit_above_maximum/);
      await expect(q(`select public.start_deposit($1, 5000, 'sandbox', 'dep:ca-1', $2)`, [u, await geoFor(u, 'deposit', 'CA')])).rejects.toThrow(/location_not_eligible/);
      await expect(q(`select public.start_deposit($1, 5000, 'sandbox', 'dep:wrong-action', $2)`, [u, await geoFor(u, 'withdrawal')])).rejects.toThrow(/location_check_required/);
      await q(`update public.profiles set self_exclusion_until = now() + interval '1 day' where id = $1`, [u]);
      await expect(q(`select public.start_deposit($1, 5000, 'sandbox', 'dep:excluded', $2)`, [u, await geoFor(u, 'deposit')])).rejects.toThrow(/self_excluded/);
      const held = await user(); // exclusions can't be shortened, so use a fresh player for the hold check
      await q(`update public.profiles set flags = '{"blocked": true}' where id = $1`, [held]);
      await expect(q(`select public.start_deposit($1, 5000, 'sandbox', 'dep:blocked', $2)`, [held, await geoFor(held, 'deposit')])).rejects.toThrow(/account_blocked/);
    });

    it('withdraws only after KYC, only to a method the player deposited with', async () => {
      const { u, method } = await fundedVerified();
      const other = await fundedVerified();
      await expect(withdraw(u, other.method, 1_000)).rejects.toThrow(/method_not_found/);
      await q(`update public.profiles set kyc_status = 'pending' where id = $1`, [u]);
      await expect(withdraw(u, method, 1_000)).rejects.toThrow(/kyc_required/);
      await q(`update public.profiles set kyc_status = 'approved' where id = $1`, [u]);
      const fresh = (await one<{ id: string }>(
        `insert into public.payment_methods (user_id, provider, provider_token, kind, label) values ($1, 'sandbox', $2, 'bank', 'Never used') returning id`,
        [u, `tok_${randomUUID()}`],
      ))!.id;
      await expect(withdraw(u, fresh, 1_000)).rejects.toThrow(/method_not_verified/);
      await expect(withdraw(u, method, 20_000)).rejects.toThrow(/insufficient_funds/);
      const w = await withdraw(u, method, 4_000);
      expect(w.status).toBe('requested');
      const wl = await one<{ available_cents: string; held_cents: string }>(`select * from public.wallets where user_id = $1`, [u]);
      expect([Number(wl!.available_cents), Number(wl!.held_cents)]).toEqual([6_000, 4_000]);
    });

    it('cancel and reject return held money; approve + payout pays it out', async () => {
      const { u, method } = await fundedVerified();
      const a = await withdraw(u, method, 2_000);
      await q(`select public.cancel_withdrawal($1, $2)`, [u, a.id]);
      expect((await status(a.id)).status).toBe('cancelled');
      const b = await withdraw(u, method, 2_000);
      await expect(q(`select public.review_withdrawal($1, false, '', 'op')`, [b.id])).rejects.toThrow(/reason required/);
      await q(`select public.review_withdrawal($1, false, 'name mismatch', 'op')`, [b.id]);
      expect(await status(b.id)).toEqual({ status: 'rejected', failure_reason: 'name mismatch' });
      expect((await wallet(u)).available).toBe(10_000);

      const c = await withdraw(u, method, 3_000);
      await q(`select public.review_withdrawal($1, true, null, 'op')`, [c.id]);
      const ref = `po_${randomUUID()}`;
      await q(`select public.set_payment_ref($1, $2)`, [c.id, ref]);
      expect(await event('payout.paid', ref, 9_999)).toBe('amount_mismatch');
      expect(await event('payout.paid', ref, 3_000)).toBe('paid');
      expect(await event('payout.paid', ref, 3_000)).toBe('already_applied');
      const wl = await one<{ available_cents: string; held_cents: string }>(`select * from public.wallets where user_id = $1`, [u]);
      expect([Number(wl!.available_cents), Number(wl!.held_cents)]).toEqual([7_000, 0]);

      const d = await withdraw(u, method, 1_000);
      await q(`select public.review_withdrawal($1, true, null, 'op')`, [d.id]);
      const ref2 = `po_${randomUUID()}`;
      await q(`select public.set_payment_ref($1, $2)`, [d.id, ref2]);
      expect(await event('payout.failed', ref2, 1_000, { reason: 'account closed' })).toBe('released');
      expect((await wallet(u)).available).toBe(7_000);
      await expect(q(`select public.cancel_withdrawal($1, $2)`, [u, d.id])).rejects.toThrow(/withdrawal_not_cancellable/);
    });

    it('a chargeback freezes the account and claws back unspent cash', async () => {
      const s = await slate();
      const { u, deposit, method } = await fundedVerified(5_000);
      await place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 3_000);
      expect(await event('deposit.reversed', deposit.ref, 5_000)).toBe('reversed');
      expect((await wallet(u)).available).toBe(0);
      expect((await status(deposit.id)).failure_reason).toMatch(/clawed back 2000 of 5000 cents; shortfall 3000/);
      expect(await one(`select flags->>'blocked' as b, flags->>'chargeback' as c from public.profiles where id = $1`, [u])).toEqual({ b: 'true', c: 'true' });
      expect(await one(`select status from public.payment_methods where id = $1`, [method])).toEqual({ status: 'blocked' });
      await expect(place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }], 100)).rejects.toThrow(/account_blocked/);
    });

    it('reconciles the provider report against payments and the ledger', async () => {
      const { deposit } = await fundedVerified(5_000);
      await q(`delete from public.provider_settlements`);
      expect(await q(`select * from public.reconcile_payments()`)).toEqual([]);
      await q(`insert into public.provider_settlements (provider, provider_ref, direction, amount_cents) select provider, provider_ref, direction, amount_cents from public.payments where status in ('succeeded','paid','reversed')`);
      expect(await q(`select * from public.reconcile_payments()`)).toEqual([]);
      await q(`update public.provider_settlements set amount_cents = 4_999 where provider_ref = $1`, [deposit.ref]);
      await q(`insert into public.provider_settlements (provider, provider_ref, direction, amount_cents) values ('sandbox', 'sbx_ghost', 'deposit', 7_500)`);
      await q(`delete from public.provider_settlements where provider_ref = (select provider_ref from public.payments where status = 'paid' limit 1)`);
      const issues = (await q<{ issue: string; provider_ref: string }>(`select issue, provider_ref from public.reconcile_payments()`)).map((r) => r.issue);
      expect(issues).toEqual(expect.arrayContaining(['amount_mismatch', 'missing_internally', 'missing_at_provider']));
      await q(`delete from public.provider_settlements`);
    });

    it('keeps webhook events append-only and hides provider tokens from players', async () => {
      const { u } = await fundedVerified(2_000);
      await expect(q(`delete from public.payment_events`)).rejects.toThrow(/append-only/);
      await expect(q(`update public.payment_events set result = 'x'`)).rejects.toThrow(/append-only/);
      await expect(q(`truncate public.payment_events`)).rejects.toThrow(/append-only/);
      const c = await db.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [u]);
        await c.query('set local role authenticated');
        const tryQ = async (sql: string) => {
          await c.query('savepoint t');
          try {
            return (await c.query(sql)).rows;
          } catch (e) {
            await c.query('rollback to savepoint t');
            throw e;
          }
        };
        expect(await tryQ(`select label, status from public.payment_methods`)).toEqual([{ label: 'Visa •••• 4242', status: 'active' }]);
        await expect(tryQ(`select provider_token from public.payment_methods`)).rejects.toThrow(/permission denied/);
        expect(await tryQ(`select direction, amount_cents, status from public.payments`)).toEqual([{ direction: 'deposit', amount_cents: '2000', status: 'succeeded' }]);
        await expect(tryQ(`select provider_ref from public.payments`)).rejects.toThrow(/permission denied/);
        await expect(tryQ(`select public.process_payment_event('sandbox','x','deposit.succeeded','y',1,'{}')`)).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('rollback');
        c.release();
      }
    });
  });

  describe('phase 5: limits, exclusions, audit log, rate limits', () => {
    const picks = (s: Awaited<ReturnType<typeof slate>>) => [{ id: s.a, d: 'more' as const }, { id: s.b, d: 'less' as const }];
    const setLimit = (u: string, kind: string, period: string, cents: number | null) =>
      one<{ effective_at: Date }>(`select * from public.set_limit($1, $2, $3, $4, 'player')`, [u, kind, period, cents]);
    const depositGeo = async (u: string) =>
      (await one<{ id: string }>(`insert into public.geo_checks (user_id, action, region, country, provider, decision) values ($1, 'deposit', 'NJ', 'US', 'test', 'allow') returning id`, [u]))!.id;

    it('applies a stricter limit now and a looser one only after 24 hours', async () => {
      const u = await user();
      const first = await setLimit(u, 'stake', 'day', 5_000);
      expect(Math.abs(+first!.effective_at - Date.now())).toBeLessThan(5_000);
      const looser = await setLimit(u, 'stake', 'day', 50_000);
      expect(+looser!.effective_at - Date.now()).toBeGreaterThan(23 * 3600_000);
      expect(await one(`select public.current_limit($1, 'stake', 'day') as l`, [u])).toEqual({ l: '5000' });
      const removed = await setLimit(u, 'stake', 'day', null);
      expect(+removed!.effective_at - Date.now()).toBeGreaterThan(23 * 3600_000);
      await setLimit(u, 'stake', 'day', 3_000); // tightening applies at once, even with a looser request pending
      expect(await one(`select public.current_limit($1, 'stake', 'day') as l`, [u])).toEqual({ l: '3000' });
      await expect(q(`update public.player_limits set amount_cents = 1 where user_id = $1`, [u])).rejects.toThrow(/append-only/);
    });

    it('blocks entries over a stake limit and over a loss limit', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 20_000);
      await setLimit(u, 'stake', 'week', 2_500);
      await place(u, picks(s), 2_000);
      await expect(place(u, [{ id: s.c, d: 'more' }, { id: s.d, d: 'less' }], 1_000)).rejects.toThrow(/limit_exceeded:stake:week:500/);
      const v = await user();
      await deposit(v, 20_000);
      await setLimit(v, 'loss', 'day', 1_500);
      const e = (await place(v, picks(s), 1_000))!;
      await grade(s.a, 10); // lost
      await grade(s.b, 3);
      expect((await entry(e.id))!.status).toBe('lost');
      await expect(place(v, [{ id: s.c, d: 'more' }, { id: s.d, d: 'less' }], 600)).rejects.toThrow(/limit_exceeded:loss:day/);
      expect((await place(v, [{ id: s.c, d: 'more' }, { id: s.d, d: 'less' }], 500))!.status).toBe('open');
    });

    it('blocks deposits over a deposit limit, counting pending checkouts', async () => {
      const u = await user();
      await setLimit(u, 'deposit', 'month', 5_000);
      await q(`select public.start_deposit($1, 3000, 'sandbox', 'dep:lim-1', $2)`, [u, await depositGeo(u)]);
      await expect(q(`select public.start_deposit($1, 2500, 'sandbox', 'dep:lim-2', $2)`, [u, await depositGeo(u)])).rejects.toThrow(/limit_exceeded:deposit:month:2000/);
      await q(`select public.start_deposit($1, 2000, 'sandbox', 'dep:lim-3', $2)`, [u, await depositGeo(u)]);
    });

    it('stops counting an abandoned checkout after an hour', async () => {
      const u = await user();
      await setLimit(u, 'deposit', 'day', 5_000);
      await q(`select public.start_deposit($1, 4000, 'sandbox', 'dep:abandon-1', $2)`, [u, await depositGeo(u)]);
      expect(await one(`select public.limit_usage($1, 'deposit', now() - interval '1 day') as n`, [u])).toEqual({ n: '4000' });
      await q(`update public.payments set created_at = now() - interval '2 hours' where idempotency_key = 'dep:abandon-1'`);
      expect(await one(`select public.limit_usage($1, 'deposit', now() - interval '1 day') as n`, [u])).toEqual({ n: '0' });
    });

    it('cool-off and self-exclusion block deposits and entries at once and can only be extended', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const until = (await one<{ u: Date }>(`select public.set_exclusion($1, 'cool_off', 1, 'player') as u`, [u]))!.u;
      expect(+until - Date.now()).toBeGreaterThan(23 * 3600_000);
      await expect(place(u, picks(s), 1_000)).rejects.toThrow(/self_excluded/);
      await expect(q(`select public.start_deposit($1, 2000, 'sandbox', 'dep:cool', $2)`, [u, await depositGeo(u)])).rejects.toThrow(/self_excluded/);
      await expect(q(`update public.profiles set self_exclusion_until = null where id = $1`, [u])).rejects.toThrow(/cannot_be_shortened/);
      await expect(q(`select public.set_exclusion($1, 'cool_off', 3, 'player')`, [u])).rejects.toThrow(/invalid_cool_off/);
      const perm = (await one<{ u: string }>(`select public.set_exclusion($1, 'self_exclusion', null, 'player')::text as u`, [u]))!.u;
      expect(perm).toBe('infinity');
      await q(`select public.set_exclusion($1, 'cool_off', 1, 'operator')`, [u]); // a shorter one never shortens it
      expect(await one(`select self_exclusion_until::text as u from public.profiles where id = $1`, [u])).toEqual({ u: 'infinity' });
    });

    it('reports spend for each period', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      await place(u, [{ id: s.c, d: 'more' }, { id: s.d, d: 'less' }], 1_500);
      const rows = await q<{ period: string; staked_cents: string }>(`select * from public.spend_summary($1)`, [u]);
      expect(rows.map((r) => [r.period, Number(r.staked_cents)])).toEqual([['day', 1_500], ['week', 1_500], ['month', 1_500], ['all', 1_500]]);
    });

    it('writes an append-only audit trail for money, limits, exclusions and holds', async () => {
      const u = await user();
      await deposit(u, 4_200);
      await setLimit(u, 'deposit', 'day', 10_000);
      await q(`select public.set_exclusion($1, 'cool_off', 7, 'player')`, [u]);
      await q(`update public.profiles set flags = flags || '{"blocked": true}' where id = $1`, [u]);
      await q(`select public.log_audit('operator:ops@test', 'account.hold', $1::uuid, 'profiles', $2::text, '{"reason":"test"}')`, [u, u]);
      const rows = await q<{ action: string; actor: string; details: Record<string, unknown> }>(`select action, actor, details from public.audit_log where subject_user = $1 order by id`, [u]);
      const actions = rows.map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['ledger.deposit', 'limit.set', 'exclusion.cool_off', 'profile.update', 'account.hold']));
      expect(rows.find((r) => r.action === 'ledger.deposit')!.details.amount_cents).toBe(4_200);
      expect(rows.find((r) => r.action === 'account.hold')!.actor).toBe('operator:ops@test');
      await expect(q(`delete from public.audit_log where subject_user = $1`, [u])).rejects.toThrow(/append-only/);
      await expect(q(`update public.audit_log set actor = 'x' where subject_user = $1`, [u])).rejects.toThrow(/append-only/);
    });

    it('rate-limits per key and window', async () => {
      const key = `test:${randomUUID()}`;
      const results = [];
      for (let i = 0; i < 4; i++) results.push((await one<{ ok: boolean }>(`select public.hit_rate_limit($1, 3, 60) as ok`, [key]))!.ok);
      expect(results).toEqual([true, true, true, false]);
    });
  });

  describe('phase 6: operator console', () => {
    it('force-settles a single leg with a reason, then settles the entry', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const e = (await place(u, [{ id: s.a, d: 'more' }, { id: s.b, d: 'less' }, { id: s.c, d: 'more' }], 1_000))!;
      await expect(q(`select public.force_settle_leg($1, $2, 'hit', '', 'operator:ops')`, [e.id, s.a])).rejects.toThrow(/reason required/);
      await q(`select public.force_settle_leg($1, $2, 'void', 'stat correction from league', 'operator:ops')`, [e.id, s.a]);
      await expect(q(`select public.force_settle_leg($1, $2, 'hit', 'again', 'operator:ops')`, [e.id, s.a])).rejects.toThrow(/leg_already_settled/);
      expect((await entry(e.id))!.status).toBe('open');
      await grade(s.b, 3);
      await grade(s.c, 9);
      const done = (await entry(e.id))!;
      expect([done.status, Number(done.payout_cents)]).toEqual(['won', 3_000]); // re-priced as a 2-pick
      const audit = await one<{ actor: string; details: Record<string, unknown> }>(
        `select actor, details from public.audit_log where action = 'operator.force_settle_leg' and entity_id = $1`, [e.id]);
      expect(audit).toMatchObject({ actor: 'operator:ops', details: { result: 'void', reason: 'stat correction from league' } });
      await expect(q(`select public.force_settle_leg($1, $2, 'hit', 'too late', 'operator:ops')`, [e.id, s.b])).rejects.toThrow(/entry_already_settled/);
    });

    it('marks a pending deposit failed without moving money, and refuses a late success', async () => {
      const u = await user();
      const geo = (await one<{ id: string }>(`insert into public.geo_checks (user_id, action, region, country, provider, decision) values ($1, 'deposit', 'NJ', 'US', 'test', 'allow') returning id`, [u]))!.id;
      const pay = (await one<{ id: string }>(`select * from public.start_deposit($1, 2500, 'sandbox', 'dep:stale-1', $2)`, [u, geo]))!;
      await q(`select public.set_payment_ref($1, 'sbx_stale_1')`, [pay.id]);
      await q(`select public.fail_pending_deposit($1, 'processor confirmed abandoned', 'operator:ops')`, [pay.id]);
      expect(await one(`select status from public.payments where id = $1`, [pay.id])).toEqual({ status: 'failed' });
      expect(await one(`select public.process_payment_event('sandbox', 'evt_late_1', 'deposit.succeeded', 'sbx_stale_1', 2500, '{}') as r`)).toEqual({ r: 'invalid_state:failed' });
      expect((await wallet(u)).available).toBe(0);
      await expect(q(`select public.fail_pending_deposit($1, 'again', 'operator:ops')`, [pay.id])).rejects.toThrow(/deposit_not_pending/);
    });

    it('lists a player’s sessions without exposing them to players', async () => {
      const u = await user();
      await q(`insert into auth.sessions (user_id, user_agent, ip) values ($1, 'Mozilla/5.0 test', '203.0.113.9')`, [u]);
      const rows = await q<{ s: Record<string, unknown> }>(`select public.player_sessions($1) as s`, [u]);
      expect(rows[0].s).toMatchObject({ user_agent: 'Mozilla/5.0 test', ip: '203.0.113.9' });
    });
  });

  describe('Venom/Shield picks and countries', () => {
    async function tiered(gameId: string, team: string, line: number, tier: 'venom' | 'shield', factor: number, player = randomUUID()) {
      return (await one<{ id: string }>(
        `insert into public.projections (game_id, slate_date, player_id, player_name, team, position, stat_type, line, tier, payout_factor)
         values ($1, current_date, $2, 'Tier Player', $3, 'G', 'Points', $4, $5, $6) returning id`,
        [gameId, player, team, line, tier, factor],
      ))!.id;
    }

    it('rejects a factor that doesn’t match the tier', async () => {
      const g = await game(90, 'TFA', 'TFB');
      await expect(tiered(g, 'TFA', 30.5, 'venom', 0.8)).rejects.toThrow(/projections_tier_factor/);
      await expect(tiered(g, 'TFA', 30.5, 'shield', 1.5)).rejects.toThrow(/projections_tier_factor/);
    });

    it('Venom and Shield are More-only and multiply the payout', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const v = await tiered(s.g1, 'HAR', 30.5, 'venom', 1.5);
      await expect(place(u, [{ id: v, d: 'less' }, { id: s.b, d: 'less' }], 1_000)).rejects.toThrow(/tiered_more_only/);
      const e = (await place(u, [{ id: v, d: 'more' }, { id: s.b, d: 'less' }, { id: s.c, d: 'more' }], 1_000))!;
      expect(Number(e.multiplier)).toBe(7.5);
      expect(Number(e.potential_payout_cents)).toBe(7_500);
      await grade(v, 33);
      await grade(s.b, 4);
      await grade(s.c, 9);
      const done = (await entry(e.id))!;
      expect([done.status, Number(done.payout_cents), Number(done.settled_multiplier)]).toEqual(['won', 7_500, 7.5]);

      const sh = await tiered(s.g2, 'CAP', 12.5, 'shield', 0.6);
      const e2 = (await place(u, [{ id: sh, d: 'more' }, { id: s.f, d: 'less' }], 1_000))!;
      expect(Number(e2.multiplier)).toBe(1.8);
    });

    it('a pushed or voided tiered leg drops its factor when re-pricing', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const v = await tiered(s.g1, 'HAR', 30, 'venom', 2);
      const e = (await place(u, [{ id: v, d: 'more' }, { id: s.b, d: 'less' }, { id: s.c, d: 'more' }], 1_000))!;
      expect(Number(e.multiplier)).toBe(10);
      await grade(v, 30); // push: drops out, factor and all
      await grade(s.b, 4);
      await grade(s.c, 9);
      const done = (await entry(e.id))!;
      expect([done.status, Number(done.settled_multiplier), Number(done.payout_cents)]).toEqual(['won', 3, 3_000]);
    });

    it('keeps one pick per player across a standard line and its Venom line', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const player = (await one<{ player_id: string }>(`select player_id from public.projections where id = $1`, [s.a]))!.player_id;
      const v = await tiered(s.g1, 'HAR', 30.5, 'venom', 1.5, player);
      await expect(place(u, [{ id: s.a, d: 'more' }, { id: v, d: 'more' }, { id: s.b, d: 'less' }], 1_000)).rejects.toThrow(/one_pick_per_player/);
    });

    it('plays outside the US only in countries an operator has enabled, at that country’s age', async () => {
      const s = await slate();
      const u = await user();
      await deposit(u, 10_000);
      const nineteen = new Date(Date.now() - 19.5 * 365.25 * 864e5).toISOString().slice(0, 10);
      await q(`update public.profiles set country = 'GB', state = null, dob = $2 where id = $1`, [u, nineteen]);
      const gb = async () =>
        (await one<{ id: string }>(`insert into public.geo_checks (user_id, action, region, country, provider, decision) values ($1, 'entry', 'ENG', 'GB', 'test', 'allow') returning id`, [u]))!.id;
      const picks = [{ id: s.a, d: 'more' as const }, { id: s.b, d: 'less' as const }];
      await expect(place(u, picks, 1_000, undefined, await gb())).rejects.toThrow(/location_not_eligible/);
      await q(`update public.countries set enabled = true, min_age = 18 where code = 'GB'`);
      expect((await place(u, picks, 1_000, undefined, await gb()))!.status).toBe('open');
      await q(`update public.countries set min_age = 21 where code = 'GB'`);
      await expect(place(u, [{ id: s.c, d: 'more' }, { id: s.d, d: 'less' }], 1_000, undefined, await gb())).rejects.toThrow(/under_age/);
      await q(`update public.countries set enabled = false, min_age = 18 where code = 'GB'`);
    });
  });

  it('the whole ledger still reconciles to zero', async () => {
    expect(await reconcile()).toEqual([]);
    const total = await one<{ s: string }>(`select coalesce(sum(amount_cents),0)::text as s from public.ledger_postings`);
    expect(total!.s).toBe('0');
  });
});
