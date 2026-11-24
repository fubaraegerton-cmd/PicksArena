import { scoreboard, leagueGames, team, type FeedGame, type Scoreboard } from './sportsdb.js';
import { db, supabaseConfigured } from './supabase.js';

/**
 * Live data from TheSportsDB:
 *  - GET /api/scores: scoreboard for the site (cached for a minute here and at the CDN).
 *  - syncGames(): imports real NBA/NFL games into the real-money slate and keeps their
 *    status and scores current. Lines are still posted by the operator; Venom follows automatically.
 */

let cache: { at: number; data: Scoreboard } | null = null;
const TTL = 60_000;

export async function scoresGET(): Promise<Response> {
  try {
    if (!cache || Date.now() - cache.at > TTL) cache = { at: Date.now(), data: await scoreboard() };
    return new Response(JSON.stringify(cache.data), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
}

const REAL_MONEY_LEAGUES = [
  { id: '4387', sport: 'NBA' as const },
  { id: '4391', sport: 'NFL' as const },
];
const SYNC_EVERY = 5 * 60_000;

export interface SyncResult {
  imported: number;
  updated: number;
  finals: number;
  voided: number;
  skipped: number;
}

interface GameRow {
  id: string;
  external_id: string | null;
  status: 'scheduled' | 'in_progress' | 'final' | 'void';
  starts_at: string;
  home_score: number | null;
  away_score: number | null;
}

/** Imports today's and the next two days' NBA/NFL games and updates the ones already imported. */
export async function syncGames(now = Date.now()): Promise<SyncResult> {
  const r: SyncResult = { imported: 0, updated: 0, finals: 0, voided: 0, skipped: 0 };
  const days = [now - 86400_000, now, now + 86400_000, now + 2 * 86400_000];
  const feed: (FeedGame & { dbSport: 'NBA' | 'NFL' })[] = [];
  for (const l of REAL_MONEY_LEAGUES) for (const g of await leagueGames(l.id, days)) feed.push({ ...g, dbSport: l.sport });
  if (!feed.length) return r;

  const ext = feed.map((g) => `tsdb:${g.id}`);
  const { data: existing, error } = await db().from('games').select('id, external_id, status, starts_at, home_score, away_score').in('external_id', ext);
  if (error) throw new Error(error.message);
  const byExt = new Map((existing as GameRow[]).map((g) => [g.external_id, g]));

  for (const g of feed) {
    const row = byExt.get(`tsdb:${g.id}`);
    if (!row) {
      // Only import games that haven't started; never create past games.
      if (g.status !== 'scheduled' || g.startsAt <= now) {
        r.skipped++;
        continue;
      }
      const [home, away] = await Promise.all([team(g.home.id), team(g.away.id)]);
      if (!home || !away || home.abbr === away.abbr) {
        r.skipped++;
        continue;
      }
      const { error: ie } = await db().from('games').insert({
        sport: g.dbSport,
        external_id: `tsdb:${g.id}`,
        home_team: home.abbr,
        away_team: away.abbr,
        home_name: home.name,
        away_name: away.name,
        home_color: home.color,
        away_color: away.color,
        starts_at: new Date(g.startsAt).toISOString(),
      });
      if (ie) r.skipped++;
      else r.imported++;
      continue;
    }
    if (row.status === 'void' || row.status === 'final') continue;

    if (g.status === 'cancelled') {
      const { error: ve } = await db().rpc('void_game', { p_game: row.id });
      if (!ve) r.voided++;
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (g.status === 'scheduled' && Math.abs(Date.parse(row.starts_at) - g.startsAt) > 60_000 && g.startsAt > now) patch.starts_at = new Date(g.startsAt).toISOString();
    if (g.home.score !== null && g.home.score !== row.home_score) patch.home_score = g.home.score;
    if (g.away.score !== null && g.away.score !== row.away_score) patch.away_score = g.away.score;
    if (g.status === 'live' && row.status === 'scheduled') patch.status = 'in_progress';
    if (g.status === 'final') {
      patch.status = 'final';
      r.finals++;
    }
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      const { error: ue } = await db().from('games').update(patch).eq('id', row.id);
      if (!ue) r.updated++;
    }
  }
  return r;
}

/**
 * Runs syncGames at most every few minutes, coordinated through feed_state so concurrent
 * requests don't all hit the feed. Errors are recorded, never thrown to the caller.
 */
export async function maybeSync(force = false): Promise<{ ran: boolean; result?: SyncResult; error?: string }> {
  if (!supabaseConfigured()) return { ran: false };
  const { data: claimed, error } = await db().rpc('claim_feed_run', { p_key: 'thesportsdb', p_every_seconds: force ? 0 : SYNC_EVERY / 1000 });
  if (error || !claimed) return { ran: false, error: error?.message };
  try {
    const result = await syncGames();
    await db().from('feed_state').update({ last_ok: new Date().toISOString(), last_result: result, last_error: null }).eq('key', 'thesportsdb');
    return { ran: true, result };
  } catch (e) {
    const msg = (e as Error).message;
    await db().from('feed_state').update({ last_error: msg }).eq('key', 'thesportsdb');
    return { ran: true, error: msg };
  }
}

export async function feedStatus() {
  if (!supabaseConfigured()) return null;
  const { data } = await db().from('feed_state').select('*').eq('key', 'thesportsdb').maybeSingle();
  return data;
}
