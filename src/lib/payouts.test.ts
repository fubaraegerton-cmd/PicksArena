import { describe, expect, it } from 'vitest';
import { generateBoard } from '../data/generate';
import { payoutMultiplier, validateLineup } from './payouts';
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
