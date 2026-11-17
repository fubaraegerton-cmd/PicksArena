import { describe, expect, it } from 'vitest';
import { applyAction, EMPTY_DATA, validateAction, type AdminAction, type AdminData } from './admin';
import { adminActuals, adminProjections, adminProjectionId } from '../lib/adminBoard';
import { fullyResulted, settleEntry } from '../lib/simulate';
import type { Entry } from '../types';

const NOW = Date.UTC(2026, 10, 17, 12);
let n = 0;
const id = () => `id${++n}`;

function run(data: AdminData, a: AdminAction): AdminData {
  const err = validateAction(a, data);
  if (err) throw new Error(err);
  return { ...applyAction(a, data, id, NOW), version: data.version + 1 };
}

const home = { abbr: 'HAR', name: 'Harbor City Waves', color: '#1f7ae0' };
const away = { abbr: 'DSR', name: 'Desert Rattlers', color: '#e0761f' };

function seeded() {
  let d = run(EMPTY_DATA, { action: 'createGame', game: { sport: 'NBA', home, away, startsAt: NOW + 3600_000 } });
  const gameId = d.games[0].id;
  d = run(d, {
    action: 'createPick',
    pick: { gameId, side: 'home', playerName: 'Jalen Carver', position: 'pg', number: 3, statType: 'Points', line: 24.5, special: true, note: 'Lock' },
  });
  d = run(d, {
    action: 'createPick',
    pick: { gameId, side: 'away', playerName: 'Kofi Okafor', position: 'C', statType: 'Rebounds', line: 10.5, special: false },
  });
  return d;
}

describe('admin actions', () => {
  it('creates games and picks', () => {
    const d = seeded();
    expect(d.games).toHaveLength(1);
    expect(d.picks).toHaveLength(2);
    expect(d.picks[0].position).toBe('PG');
    expect(d.picks[0].active).toBe(true);
  });

  it('rejects bad input', () => {
    const d = seeded();
    const gameId = d.games[0].id;
    const base = { gameId, side: 'home' as const, playerName: 'New Guy', position: 'SF', statType: 'Assists', special: false };
    expect(validateAction({ action: 'createPick', pick: { ...base, line: 24 } }, d)).toMatch(/\.5/);
    expect(validateAction({ action: 'createPick', pick: { ...base, playerName: 'Jalen Carver', statType: 'Points', line: 20.5 } }, d)).toMatch(/already/);
    expect(validateAction({ action: 'createGame', game: { sport: 'NBA', home, away: home, startsAt: NOW } }, d)).toMatch(/different/);
    expect(validateAction({ action: 'createGame', game: { sport: 'NBA', home: { ...home, color: 'blue' }, away, startsAt: NOW } }, d)).toMatch(/hex/);
  });

  it('deleting a game removes its picks', () => {
    const d = seeded();
    const after = run(d, { action: 'deleteGame', id: d.games[0].id });
    expect(after.picks).toHaveLength(0);
  });

  it('sets and clears results', () => {
    let d = seeded();
    const pid = d.picks[0].id;
    d = run(d, { action: 'updatePick', id: pid, patch: { actual: 30 } });
    expect(d.picks[0].actual).toBe(30);
    d = run(d, { action: 'updatePick', id: pid, patch: { actual: null } });
    expect(d.picks[0].actual).toBeUndefined();
  });
});

describe('admin board + settlement', () => {
  it('only shows active picks from scheduled games', () => {
    let d = seeded();
    expect(adminProjections(d)).toHaveLength(2);
    expect(adminProjections(d)[0]).toMatchObject({ special: true, note: 'Lock', source: 'admin' });
    d = run(d, { action: 'updatePick', id: d.picks[1].id, patch: { active: false } });
    expect(adminProjections(d)).toHaveLength(1);
    d = run(d, { action: 'updateGame', id: d.games[0].id, patch: { status: 'cancelled' } });
    expect(adminProjections(d)).toHaveLength(0);
  });

  it('settles with the official result instead of simulating', () => {
    let d = seeded();
    const projections = adminProjections(d);
    const entry: Entry = {
      id: 'E1', createdAt: NOW, playType: 'power', amount: 10, status: 'open', payout: 0, potentialPayout: 30,
      picks: [
        { projection: projections[0], direction: 'more', result: 'pending' },
        { projection: projections[1], direction: 'less', result: 'pending' },
      ],
    };
    expect(fullyResulted(entry, adminActuals(d))).toBe(false);
    d = run(d, { action: 'updatePick', id: d.picks[0].id, patch: { actual: 31 } });
    d = run(d, { action: 'updatePick', id: d.picks[1].id, patch: { actual: 8 } });
    const actuals = adminActuals(d);
    expect(actuals.get(adminProjectionId(d.picks[0].id))).toBe(31);
    expect(fullyResulted(entry, actuals)).toBe(true);
    const s = settleEntry(entry, Math.random, actuals);
    expect(s.picks.map((p) => p.actual)).toEqual([31, 8]);
    expect(s.status).toBe('won');
    expect(s.payout).toBe(30);
  });
});
