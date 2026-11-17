import type { Game, Player, Projection, SportId } from '../types';
import { SPORTS } from './sports';
import { hashString, mulberry32, normal } from '../lib/random';

const FIRST = [
  'Marcus', 'Jalen', 'Dante', 'Tyrell', 'Cole', 'Mateo', 'Ezra', 'Andre', 'Luca', 'Kofi',
  'Rafael', 'Owen', 'Isaiah', 'Theo', 'Kai', 'Darius', 'Nico', 'Emmett', 'Jonah', 'Malik',
  'Silas', 'Xavier', 'Bennett', 'Tobias', 'Amari', 'Reid', 'Quinn', 'Rowan', 'Zane', 'Hugo',
];
const LAST = [
  'Holloway', 'Carver', 'Okafor', 'Lindqvist', 'Reyes', 'Brannigan', 'Ashford', 'Delacroix',
  'Whitlock', 'Mbeki', 'Sorensen', 'Vance', 'Castellano', 'Pryor', 'Kimura', 'Abernathy',
  'Fairbanks', 'Oduya', 'Marchetti', 'Strand', 'Galloway', 'Thorne', 'Ellison', 'Navarro',
  'Quarles', 'Harlow', 'Beckett', 'Iwu', 'Novak', 'Rourke',
];

/** Round to a half-point line (always x.5 so there are no pushes). */
function toLine(v: number, min: number): number {
  const base = Math.max(min, v);
  return Math.floor(base) + 0.5;
}

export function generateBoard(dayKey: string, now = Date.now()): Projection[] {
  const rand = mulberry32(hashString(dayKey));
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const usedNames = new Set<string>();
  const projections: Projection[] = [];

  for (const sport of SPORTS) {
    const teams = [...sport.teams].sort(() => rand() - 0.5);
    const games: Game[] = [];
    for (let i = 0; i + 1 < teams.length; i += 2) {
      // Games start between 30 min and ~30 h from now, snapped to 15 minutes
      const offset = (0.5 + rand() * 30) * 3600_000;
      const startsAt = Math.round((now + offset) / 900_000) * 900_000;
      games.push({
        id: `${sport.id}-g${i / 2}`,
        sport: sport.id,
        home: teams[i],
        away: teams[i + 1],
        startsAt,
      });
    }

    for (const game of games) {
      for (const team of [game.home, game.away]) {
        const opponent = team === game.home ? game.away : game.home;
        const rosterSize = sport.positions.length + 1;
        for (let p = 0; p < rosterSize; p++) {
          let name = '';
          do {
            name = `${pick(FIRST)} ${pick(LAST)}`;
          } while (usedNames.has(name));
          usedNames.add(name);
          const position = sport.positions[p % sport.positions.length];
          const player: Player = {
            id: `${sport.id}-${team.abbr}-${p}`,
            name,
            position,
            number: 1 + Math.floor(rand() * 98),
            team,
            sport: sport.id as SportId,
          };
          const stats = sport.stats[position] ?? [];
          // Each player gets 1-3 stat lines
          const count = 1 + Math.floor(rand() * Math.min(3, stats.length));
          const chosen = [...stats].sort(() => rand() - 0.5).slice(0, count);
          for (const s of chosen) {
            const v = s.mean + normal(rand) * s.spread * 0.6;
            const r = rand();
            projections.push({
              id: `${player.id}-${s.stat.replace(/\W+/g, '')}`,
              player,
              game,
              opponent,
              statType: s.stat,
              line: toLine(v, 0),
              tag: r < 0.08 ? 'hot' : r < 0.16 ? 'trending' : undefined,
              moreShare: Math.round(30 + rand() * 45),
            });
          }
        }
      }
    }
  }
  return projections;
}

/** Spread for a stat type, used when simulating results. */
export function statSpread(sport: SportId, position: string, statType: string): number {
  const cfg = SPORTS.find((s) => s.id === sport);
  const s = cfg?.stats[position]?.find((x) => x.stat === statType);
  return s?.spread ?? 1;
}
