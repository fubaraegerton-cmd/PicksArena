/**
 * TheSportsDB client (https://www.thesportsdb.com/free_sports_api).
 *
 * Free key "123": schedules, teams, badges and final scores, limited to a few events per league
 * per day and no in-game scores. A premium key (THESPORTSDB_KEY) lifts the limits and enables the
 * v2 livescore feed, which this module overlays automatically.
 *
 * TheSportsDB has no player stats or projections, so it can't create or grade player lines.
 */

const KEY = () => process.env.THESPORTSDB_KEY?.trim() || '123';
const V1 = () => `https://www.thesportsdb.com/api/v1/json/${KEY()}`;
const premium = () => KEY() !== '123';

export type FeedSport = 'NBA' | 'NFL' | 'NHL' | 'MLB' | 'Soccer' | 'CFB';

/** Leagues we show, with TheSportsDB league ids. */
export const LEAGUES: { id: string; sport: FeedSport; label: string; v2: string }[] = [
  { id: '4387', sport: 'NBA', label: 'NBA', v2: 'basketball' },
  { id: '4391', sport: 'NFL', label: 'NFL', v2: 'american_football' },
  { id: '4380', sport: 'NHL', label: 'NHL', v2: 'ice_hockey' },
  { id: '4424', sport: 'MLB', label: 'MLB', v2: 'baseball' },
  { id: '4328', sport: 'Soccer', label: 'Premier League', v2: 'soccer' },
  { id: '4479', sport: 'CFB', label: 'College Football', v2: 'american_football' },
];

export type FeedStatus = 'scheduled' | 'live' | 'final' | 'postponed' | 'cancelled';

export interface FeedTeam {
  id: string;
  name: string;
  badge: string | null;
  score: number | null;
}

export interface FeedGame {
  id: string;
  leagueId: string;
  league: string;
  sport: FeedSport;
  startsAt: number;
  status: FeedStatus;
  /** Raw status text from the feed, e.g. "Q3", "HT", "FT" */
  statusText: string;
  /** Clock / progress when live, e.g. "Q3 4:12" */
  progress: string | null;
  home: FeedTeam;
  away: FeedTeam;
}

interface RawEvent {
  idEvent: string;
  idLeague: string;
  strLeague: string;
  strTimestamp: string | null;
  dateEvent: string | null;
  strTime: string | null;
  strStatus: string | null;
  strProgress?: string | null;
  idHomeTeam: string;
  idAwayTeam: string;
  strHomeTeam: string;
  strAwayTeam: string;
  strHomeTeamBadge?: string | null;
  strAwayTeamBadge?: string | null;
  intHomeScore: string | null;
  intAwayScore: string | null;
}

const FINAL = new Set(['FT', 'AOT', 'AET', 'AP', 'PEN', 'FT_PEN', 'Match Finished', 'Final', 'F/OT', 'Finished', 'After Over Time', 'AWD', 'WO']);
const NOT_STARTED = new Set(['NS', 'Not Started', 'TBD', 'Scheduled', '']);
const POSTPONED = new Set(['PST', 'Postponed', 'SUSP', 'INT', 'Delayed']);
const CANCELLED = new Set(['CANC', 'Cancelled', 'ABD', 'Abandoned']);

export function statusOf(raw: string | null | undefined): FeedStatus {
  const s = (raw ?? '').trim();
  if (FINAL.has(s)) return 'final';
  if (NOT_STARTED.has(s)) return 'scheduled';
  if (POSTPONED.has(s)) return 'postponed';
  if (CANCELLED.has(s)) return 'cancelled';
  return 'live';
}

const num = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));

function startOf(e: RawEvent): number {
  if (e.strTimestamp) return Date.parse(e.strTimestamp.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(e.strTimestamp) ? e.strTimestamp : `${e.strTimestamp}Z`);
  return Date.parse(`${e.dateEvent}T${e.strTime ?? '00:00:00'}Z`);
}

export function normalize(e: RawEvent, sport: FeedSport, league: string): FeedGame {
  const status = statusOf(e.strStatus);
  return {
    id: e.idEvent,
    leagueId: e.idLeague,
    league,
    sport,
    startsAt: startOf(e),
    status,
    statusText: e.strStatus ?? '',
    progress: status === 'live' ? [e.strStatus, e.strProgress].filter(Boolean).join(' ') || null : null,
    home: { id: e.idHomeTeam, name: e.strHomeTeam, badge: e.strHomeTeamBadge ?? null, score: num(e.intHomeScore) },
    away: { id: e.idAwayTeam, name: e.strAwayTeam, badge: e.strAwayTeamBadge ?? null, score: num(e.intAwayScore) },
  };
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Games for one league on the given UTC days. */
export async function leagueGames(leagueId: string, days: number[]): Promise<FeedGame[]> {
  const lg = LEAGUES.find((l) => l.id === leagueId);
  if (!lg) return [];
  const lists = await Promise.all(
    days.map((d) => getJson<{ events: RawEvent[] | null }>(`${V1()}/eventsday.php?d=${ymd(d)}&l=${leagueId}`)),
  );
  const seen = new Set<string>();
  const out: FeedGame[] = [];
  for (const l of lists)
    for (const e of l?.events ?? []) {
      if (seen.has(e.idEvent)) continue;
      seen.add(e.idEvent);
      out.push(normalize(e, lg.sport, lg.label));
    }
  return out;
}

interface RawLive {
  idEvent: string;
  strStatus: string | null;
  strProgress: string | null;
  intHomeScore: string | null;
  intAwayScore: string | null;
}

/** Premium only: in-game scores, keyed by event id. */
async function liveOverlay(sports: string[]): Promise<Map<string, RawLive>> {
  const m = new Map<string, RawLive>();
  if (!premium()) return m;
  const lists = await Promise.all(
    [...new Set(sports)].map((s) => getJson<{ livescore: RawLive[] | null }>(`https://www.thesportsdb.com/api/v2/json/livescore/${s}`, { 'X-API-KEY': KEY() })),
  );
  for (const l of lists) for (const e of l?.livescore ?? []) m.set(e.idEvent, e);
  return m;
}

export interface Scoreboard {
  updatedAt: number;
  live: boolean;
  games: FeedGame[];
}

/** Yesterday, today and tomorrow (UTC) across all leagues, with live scores overlaid when available. */
export async function scoreboard(now = Date.now(), leagues = LEAGUES): Promise<Scoreboard> {
  const days = [now - 86400_000, now, now + 86400_000];
  const [lists, live] = await Promise.all([Promise.all(leagues.map((l) => leagueGames(l.id, days))), liveOverlay(leagues.map((l) => l.v2))]);
  const games = lists.flat().map((g) => {
    const l = live.get(g.id);
    if (!l) return g;
    const status = statusOf(l.strStatus);
    return {
      ...g,
      status,
      statusText: l.strStatus ?? g.statusText,
      progress: status === 'live' ? [l.strStatus, l.strProgress].filter(Boolean).join(' ') || null : null,
      home: { ...g.home, score: num(l.intHomeScore) ?? g.home.score },
      away: { ...g.away, score: num(l.intAwayScore) ?? g.away.score },
    };
  });
  // Live first, then upcoming soonest, then most recent finals
  const rank = (g: FeedGame) => (g.status === 'live' ? 0 : g.status === 'scheduled' ? 1 : 2);
  games.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.startsAt - a.startsAt : a.startsAt - b.startsAt));
  return { updatedAt: now, live: premium(), games };
}

interface RawTeam {
  idTeam: string;
  strTeam: string;
  strTeamShort: string | null;
  strColour1: string | null;
  strBadge: string | null;
}

const teamCache = new Map<string, RawTeam | null>();

/** Team details (short name, colour, badge); cached for the life of the function instance. */
export async function team(id: string): Promise<{ abbr: string; name: string; color: string | null; badge: string | null } | null> {
  if (!teamCache.has(id)) {
    const d = await getJson<{ teams: RawTeam[] | null }>(`${V1()}/lookupteam.php?id=${encodeURIComponent(id)}`);
    teamCache.set(id, d?.teams?.[0] ?? null);
  }
  const t = teamCache.get(id);
  if (!t) return null;
  const short = (t.strTeamShort ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const abbr = /^[A-Z0-9]{2,4}$/.test(short) ? short : t.strTeam.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
  const color = /^#[0-9a-f]{6}$/i.test(t.strColour1 ?? '') ? t.strColour1!.toLowerCase() : null;
  return { abbr, name: t.strTeam, color, badge: t.strBadge };
}
