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
    for (const m of ['20261119000001_ledger_and_entries', '20261119000002_slate_details', '20261120000003_compliance_gates'])
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

  it('the whole ledger still reconciles to zero', async () => {
    expect(await reconcile()).toEqual([]);
    const total = await one<{ s: string }>(`select coalesce(sum(amount_cents),0)::text as s from public.ledger_postings`);
    expect(total!.s).toBe('0');
  });
});
