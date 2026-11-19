import type { AdminData } from '../shared/admin';
import type { Projection, SportId } from '../types';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export const adminProjectionId = (pickId: string) => `adm-${pickId}`;

/** Converts admin games + picks into board projections players can pick. */
export function adminProjections(data: AdminData): Projection[] {
  const games = new Map(data.games.map((g) => [g.id, g]));
  const out: Projection[] = [];
  for (const pk of data.picks) {
    const g = games.get(pk.gameId);
    if (!g || g.status !== 'scheduled' || !pk.active) continue;
    const team = pk.side === 'home' ? g.home : g.away;
    const opponent = pk.side === 'home' ? g.away : g.home;
    out.push({
      id: adminProjectionId(pk.id),
      source: 'admin',
      special: pk.special,
      note: pk.note,
      player: {
        id: `adm-${g.id}-${pk.side}-${slug(pk.playerName)}`,
        name: pk.playerName,
        position: pk.position,
        number: pk.number,
        team,
        sport: g.sport as SportId,
      },
      game: { id: `adm-${g.id}`, sport: g.sport as SportId, home: g.home, away: g.away, startsAt: g.startsAt },
      opponent,
      statType: pk.statType,
      line: pk.line,
      moreShare: 50,
    });
  }
  return out;
}

/** Final stats entered by the admin, keyed by projection id. */
export function adminActuals(data: AdminData): Map<string, number> {
  const m = new Map<string, number>();
  for (const pk of data.picks) if (typeof pk.actual === 'number') m.set(adminProjectionId(pk.id), pk.actual);
  return m;
}
