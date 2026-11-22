import type { AdminAction, AdminData, AdminGame, AdminPick } from '../src/shared/admin.js';
import { autoVenom, validateAction } from '../src/shared/admin.js';
import { db } from './supabase.js';

/**
 * The slate (games + lines) lives in Supabase in real-money mode. These helpers map it to the
 * AdminData shape the app and operator console already use, and turn operator actions into
 * safe database operations (grading and voiding go through the settlement functions).
 */

interface GameRow {
  id: string;
  sport: 'NBA' | 'NFL';
  home_team: string;
  away_team: string;
  home_name: string | null;
  away_name: string | null;
  home_color: string | null;
  away_color: string | null;
  starts_at: string;
  status: 'scheduled' | 'in_progress' | 'final' | 'void';
  updated_at: string;
}
interface ProjectionRow {
  id: string;
  game_id: string;
  player_name: string;
  team: string;
  position: string;
  jersey: number | null;
  stat_type: string;
  line: number;
  special: boolean;
  note: string | null;
  tier: 'standard' | 'venom' | 'shield';
  payout_factor: number;
  status: 'open' | 'pulled' | 'final' | 'void';
  result: number | null;
  created_at: string;
  updated_at: string;
}

const fallbackColor = '#5b6573';

function toGame(g: GameRow): AdminGame {
  return {
    id: g.id,
    sport: g.sport,
    home: { abbr: g.home_team, name: g.home_name ?? g.home_team, color: g.home_color ?? fallbackColor },
    away: { abbr: g.away_team, name: g.away_name ?? g.away_team, color: g.away_color ?? fallbackColor },
    startsAt: Date.parse(g.starts_at),
    status: g.status === 'void' ? 'cancelled' : g.status === 'final' ? 'final' : 'scheduled',
    createdAt: Date.parse(g.updated_at),
  };
}

function toPick(p: ProjectionRow, g: GameRow | undefined): AdminPick {
  return {
    id: p.id,
    gameId: p.game_id,
    side: g && p.team === g.home_team ? 'home' : 'away',
    playerName: p.player_name,
    position: p.position,
    number: p.jersey ?? undefined,
    statType: p.stat_type,
    line: Number(p.line),
    special: p.special,
    note: p.note ?? undefined,
    active: p.status !== 'pulled',
    actual: p.result === null ? undefined : Number(p.result),
    createdAt: Date.parse(p.created_at),
    tier: p.tier ?? 'standard',
    payoutFactor: Number(p.payout_factor ?? 1),
  };
}

/**
 * @param scope 'public' = what players may see (open lines on upcoming scheduled games);
 *              'operator' = everything from the last 14 days onward.
 */
export async function loadSlate(scope: 'public' | 'operator'): Promise<AdminData> {
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  let gq = db().from('games').select('*').gte('starts_at', since).order('starts_at');
  if (scope === 'public') gq = gq.eq('status', 'scheduled').gt('starts_at', new Date().toISOString());
  const { data: games, error: ge } = await gq;
  if (ge) throw new Error(ge.message);
  const ids = (games as GameRow[]).map((g) => g.id);
  let projections: ProjectionRow[] = [];
  if (ids.length) {
    let pq = db().from('projections').select('*').in('game_id', ids).order('created_at');
    if (scope === 'public') pq = pq.eq('status', 'open');
    const { data, error } = await pq;
    if (error) throw new Error(error.message);
    projections = data as ProjectionRow[];
  }
  const byId = new Map((games as GameRow[]).map((g) => [g.id, g]));
  const updated = Math.max(
    0,
    ...(games as GameRow[]).map((g) => Date.parse(g.updated_at)),
    ...projections.map((p) => Date.parse(p.updated_at)),
  );
  return {
    version: updated,
    updatedAt: updated,
    games: (games as GameRow[]).map(toGame),
    picks: projections.map((p) => toPick(p, byId.get(p.game_id))),
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function hasEntries(projectionIds: string[]): Promise<boolean> {
  if (!projectionIds.length) return false;
  const { count, error } = await db().from('entry_picks').select('entry_id', { count: 'exact', head: true }).in('projection_id', projectionIds);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new OperatorError(friendly(error.message));
  return data;
}

export class OperatorError extends Error {}

function friendly(msg: string): string {
  if (msg.includes('already_graded')) return 'That line already has a different official result. Results can’t be changed once posted.';
  if (msg.includes('cannot_void_graded_projection')) return 'That line is already graded, so it can’t be voided.';
  if (msg.includes('projection_void')) return 'That line was voided, so it can’t be graded.';
  if (msg.includes('projections_one_open_line')) return 'That player already has an open line for this stat in this game.';
  return msg;
}

/** Applies one operator action to the Supabase slate. */
export async function applySlateAction(a: AdminAction): Promise<void> {
  const current = await loadSlate('operator');
  if (a.action === 'createGame' && !['NBA', 'NFL'].includes(a.game.sport))
    throw new OperatorError('Real-money games are NBA and NFL only.');
  const problem = validateAction(a, current, { allowWholeLines: true });
  if (problem) throw new OperatorError(problem);

  switch (a.action) {
    case 'createGame': {
      const g = a.game;
      const { error } = await db().from('games').insert({
        sport: g.sport,
        home_team: g.home.abbr.trim().toUpperCase(),
        away_team: g.away.abbr.trim().toUpperCase(),
        home_name: g.home.name.trim(),
        away_name: g.away.name.trim(),
        home_color: g.home.color.toLowerCase(),
        away_color: g.away.color.toLowerCase(),
        starts_at: new Date(g.startsAt).toISOString(),
      });
      if (error) throw new OperatorError(friendly(error.message));
      return;
    }
    case 'updateGame': {
      if (a.patch.status === 'cancelled') {
        await rpc('void_game', { p_game: a.id });
        return;
      }
      const game = current.games.find((g) => g.id === a.id)!;
      if (a.patch.status === 'scheduled' && game.status === 'cancelled')
        throw new OperatorError('A cancelled game can’t be reopened: its entries were already refunded or re-priced. Add it again instead.');
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (a.patch.status) patch.status = a.patch.status;
      if (a.patch.startsAt !== undefined) patch.starts_at = new Date(a.patch.startsAt).toISOString();
      const { error } = await db().from('games').update(patch).eq('id', a.id);
      if (error) throw new OperatorError(friendly(error.message));
      return;
    }
    case 'deleteGame': {
      const lineIds = current.picks.filter((p) => p.gameId === a.id).map((p) => p.id);
      if (await hasEntries(lineIds)) throw new OperatorError('Players have entries on this game. Cancel it instead, which refunds or re-prices them.');
      if (lineIds.length) {
        const { error } = await db().from('projections').delete().in('id', lineIds);
        if (error) throw new OperatorError(error.message);
      }
      const { error } = await db().from('games').delete().eq('id', a.id);
      if (error) throw new OperatorError(error.message);
      return;
    }
    case 'createPick': {
      const p = a.pick;
      const game = current.games.find((g) => g.id === p.gameId)!;
      if (game.startsAt <= Date.now()) throw new OperatorError('That game has already started, so no new lines can be added.');
      const team = p.side === 'home' ? game.home.abbr : game.away.abbr;
      const row = {
        game_id: game.id,
        slate_date: new Date(game.startsAt).toISOString().slice(0, 10),
        player_id: `${team.toLowerCase()}-${slug(p.playerName)}`,
        player_name: p.playerName.trim(),
        team,
        position: p.position.trim().toUpperCase(),
        jersey: p.number ?? null,
        stat_type: p.statType.trim(),
        line: p.line,
        special: !!p.special,
        note: p.note?.trim() || null,
        tier: p.tier ?? 'standard',
        payout_factor: p.tier && p.tier !== 'standard' ? p.payoutFactor : 1,
      };
      const rows = [row];
      if (a.autoVenom && row.tier === 'standard') {
        const hasVenom = current.picks.some(
          (x) => x.gameId === game.id && x.playerName.toLowerCase() === row.player_name.toLowerCase() && x.statType.toLowerCase() === row.stat_type.toLowerCase() && x.tier === 'venom',
        );
        const v = autoVenom(p.line);
        if (!hasVenom) rows.push({ ...row, line: v.line, tier: 'venom', payout_factor: v.payoutFactor, special: false });
      }
      const { error } = await db().from('projections').insert(rows);
      if (error) throw new OperatorError(friendly(error.message));
      return;
    }
    case 'updatePick': {
      const pick = current.picks.find((x) => x.id === a.id)!;
      if ('actual' in a.patch) {
        if (a.patch.actual === null || a.patch.actual === undefined)
          throw new OperatorError('Posted results are final and can’t be cleared.');
        await rpc('grade_projection', { p_projection: a.id, p_value: a.patch.actual });
        return;
      }
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (a.patch.active !== undefined) {
        if (pick.actual !== undefined) throw new OperatorError('That line is already graded.');
        patch.status = a.patch.active ? 'open' : 'pulled';
      }
      if (a.patch.special !== undefined) patch.special = a.patch.special;
      if ('note' in a.patch) patch.note = a.patch.note?.trim() || null;
      if (a.patch.line !== undefined) patch.line = a.patch.line; // placed entries keep their locked-in line
      const { error } = await db().from('projections').update(patch).eq('id', a.id);
      if (error) throw new OperatorError(friendly(error.message));
      return;
    }
    case 'deletePick': {
      if (await hasEntries([a.id])) {
        await rpc('void_projection', { p_projection: a.id });
        return;
      }
      const { error } = await db().from('projections').delete().eq('id', a.id);
      if (error) throw new OperatorError(error.message);
      return;
    }
  }
}
