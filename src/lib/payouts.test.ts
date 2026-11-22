import { describe, expect, it } from 'vitest';
import { generateBoard } from '../data/generate';
import { entryMultiplier, payoutMultiplier, validateLineup } from './payouts';
import { settleEntry } from './simulate';
import { mulberry32 } from './random';
import type { Entry } from '../types';

const NOW = Date.UTC(2026, 0, 1, 12);
const board = generateBoard('test', NOW);
const byId = new Map(board.map((p) => [p.id, p]));

describe('board generation', () => {
  it('is deterministic for a seed', () => {
    expect(generateBoard('test', NOW).map((p) => p.id)).toEqual(board.map((p) => p.id));
  });
  it('produces half-point lines and future games', () => {
    expect(board.length).toBeGreaterThan(100);
    for (const p of board) {
      expect(p.line % 1).toBe(0.5);
      expect(p.game.startsAt).toBeGreaterThan(NOW);
    }
  });
});

describe('payouts', () => {
  it('power pays only when all hit', () => {
    expect(payoutMultiplier('power', 4, 4)).toBe(10);
    expect(payoutMultiplier('power', 4, 3)).toBe(0);
  });
  it('flex pays on partial hits', () => {
    expect(payoutMultiplier('flex', 5, 4)).toBe(2);
    expect(payoutMultiplier('flex', 5, 2)).toBe(0);
  });
});

describe('validateLineup', () => {
  const [a] = board;
  const b = board.find((p) => p.player.team.abbr !== a.player.team.abbr && p.game.sport === a.game.sport)!;
  const sameTeam = board.find((p) => p.player.team.abbr === a.player.team.abbr && p.player.id !== a.player.id)!;
  const pk = (id: string) => ({ projectionId: id, direction: 'more' as const });

  it('accepts a valid 2-pick power lineup', () => {
    expect(validateLineup([pk(a.id), pk(b.id)], byId, 'power', 10, 100, NOW).ok).toBe(true);
  });
  it('requires two teams', () => {
    const v = validateLineup([pk(a.id), pk(sameTeam.id)], byId, 'power', 10, 100, NOW);
    expect(v.errors.join()).toMatch(/2 different teams/);
  });
  it('rejects flex with 2 picks and overdrafts', () => {
    expect(validateLineup([pk(a.id), pk(b.id)], byId, 'flex', 10, 100, NOW).ok).toBe(false);
    expect(validateLineup([pk(a.id), pk(b.id)], byId, 'power', 500, 100, NOW).errors).toContain('Insufficient balance.');
  });
  it('rejects started games', () => {
    expect(validateLineup([pk(a.id), pk(b.id)], byId, 'power', 10, 100, a.game.startsAt + 1).ok).toBe(false);
  });
});

describe('settleEntry', () => {
  it('settles consistently with the payout table', () => {
    const entry: Entry = {
      id: 'E1', createdAt: NOW, playType: 'flex', amount: 10, status: 'open', payout: 0, potentialPayout: 50,
      picks: board.slice(0, 4).map((projection) => ({ projection, direction: 'more', result: 'pending' })),
    };
    const s = settleEntry(entry, mulberry32(7));
    const hits = s.picks.filter((p) => p.result === 'hit').length;
    for (const p of s.picks) expect(p.result).toBe(p.actual! > p.projection.line ? 'hit' : 'miss');
    expect(s.payout).toBeCloseTo(10 * payoutMultiplier('flex', 4, hits));
    expect(s.status).toBe(s.payout > 0 ? 'won' : 'lost');
  });
});

describe('Venom and Shield', () => {
  const NOW2 = Date.UTC(2026, 0, 1, 12);
  const b = generateBoard('tiers', NOW2);
  const venom = b.find((p) => p.tier === 'venom')!;
  const shield = b.find((p) => p.tier === 'shield')!;
  const std = b.filter((p) => !p.tier && p.player.team.abbr !== venom.player.team.abbr && p.player.id !== shield.player.id);

  it('the demo board includes both kinds with valid factors', () => {
    expect(venom.payoutFactor).toBeGreaterThan(1);
    expect(shield.payoutFactor).toBeLessThan(1);
  });

  it('multiplies the power payout by every factor, like the database', () => {
    expect(entryMultiplier([venom, std[0], std[1]])).toBeCloseTo(5 * venom.payoutFactor!, 2);
    expect(entryMultiplier([shield, std[0]])).toBeCloseTo(3 * shield.payoutFactor!, 2);
    expect(entryMultiplier([std[0], std[1]])).toBe(3);
  });

  it('is More-only and Power-only', () => {
    const m = new Map(b.map((p) => [p.id, p]));
    const picks = [{ projectionId: venom.id, direction: 'less' as const }, { projectionId: std[0].id, direction: 'more' as const }];
    expect(validateLineup(picks, m, 'power', 10, 100, NOW2).errors).toContain('Venom and Shield picks can only be More.');
    const three = [{ projectionId: venom.id, direction: 'more' as const }, { projectionId: std[0].id, direction: 'more' as const }, { projectionId: std[1].id, direction: 'more' as const }];
    expect(validateLineup(three, m, 'flex', 10, 100, NOW2).errors).toContain('Venom and Shield picks are Power Play only.');
  });

  it('demo settlement pays the factored multiplier when every leg hits', () => {
    const e: Entry = {
      id: 'E2', createdAt: NOW2, playType: 'power', amount: 10, status: 'open', payout: 0, potentialPayout: 0,
      picks: [venom, std[0]].map((projection) => ({ projection, direction: 'more' as const, result: 'pending' as const })),
    };
    const finals = new Map([[venom.id, venom.line + 1], [std[0].id, std[0].line + 1]]);
    const s = settleEntry(e, Math.random, finals);
    expect(s.picks.map((p) => p.result)).toEqual(['hit', 'hit']);
    expect(s.payout).toBeCloseTo(10 * entryMultiplier([venom, std[0]]), 2);
    const lost = settleEntry(e, Math.random, new Map([[venom.id, venom.line - 1], [std[0].id, std[0].line + 1]]));
    expect([lost.status, lost.payout]).toEqual(['lost', 0]);
  });
});

describe('automatic Venom lines', () => {
  it('moves the line up a whole step and prices the move', async () => {
    const { autoVenom } = await import('../shared/admin');
    expect(autoVenom(20.5)).toEqual({ line: 23.5, payoutFactor: 1.35 });
    expect(autoVenom(6.5)).toEqual({ line: 7.5, payoutFactor: 1.4 });
    expect(autoVenom(0.5)).toEqual({ line: 1.5, payoutFactor: 3 });
    expect(autoVenom(245.5)).toEqual({ line: 282.5, payoutFactor: 1.4 });
    for (const l of [0.5, 3.5, 12.5, 48.5, 300.5]) expect(autoVenom(l).line % 1).toBe(0.5);
  });
  it('the demo store adds the Venom alternate next to a standard line', async () => {
    const { applyAction, EMPTY_DATA } = await import('../shared/admin');
    const g = { id: 'g1', sport: 'NBA', home: { abbr: 'AAA', name: 'Aaa', color: '#111111' }, away: { abbr: 'BBB', name: 'Bbb', color: '#222222' }, startsAt: Date.now() + 3.6e6, status: 'scheduled' } as never;
    const d0 = { ...EMPTY_DATA, games: [g] };
    const pick = { gameId: 'g1', side: 'home', playerName: 'Test Player', position: 'PG', statType: 'Points', line: 20.5 } as never;
    let n = 0;
    const id = () => `p${++n}`;
    const d1 = applyAction({ action: 'createPick', pick, autoVenom: true }, d0, id, 1);
    expect(d1.picks.map((p) => [p.tier, p.line, p.payoutFactor])).toEqual([['standard', 20.5, 1], ['venom', 23.5, 1.35]]);
    const d2 = applyAction({ action: 'createPick', pick: { ...(pick as object), statType: 'Rebounds' } as never }, d1, id, 2);
    expect(d2.picks).toHaveLength(3);
  });
});
