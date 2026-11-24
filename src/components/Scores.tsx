import { useCallback, useEffect, useMemo, useState } from 'react';

/** Mirrors server/sportsdb.ts FeedGame. */
interface FeedTeam {
  id: string;
  name: string;
  badge: string | null;
  score: number | null;
}
interface FeedGame {
  id: string;
  league: string;
  sport: string;
  startsAt: number;
  status: 'scheduled' | 'live' | 'final' | 'postponed' | 'cancelled';
  statusText: string;
  progress: string | null;
  home: FeedTeam;
  away: FeedTeam;
}
interface Scoreboard {
  updatedAt: number;
  live: boolean;
  games: FeedGame[];
}

const REFRESH = 60_000;

function useScoreboard() {
  const [data, setData] = useState<Scoreboard | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/scores');
      if (!r.ok) throw new Error(String(r.status));
      setData((await r.json()) as Scoreboard);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(() => document.visibilityState === 'visible' && load(), REFRESH);
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);
  return { data, failed };
}

const time = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const tmrw = new Date(today.getTime() + 86400_000).toDateString() === d.toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? t : tmrw ? `Tmrw ${t}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
};

function Team({ t, lead, showScore }: { t: FeedTeam; lead: boolean; showScore: boolean }) {
  return (
    <span className={`sc-team ${lead ? 'lead' : ''}`}>
      {t.badge ? <img src={`${t.badge}/tiny`} alt="" width={20} height={20} loading="lazy" referrerPolicy="no-referrer" /> : <i aria-hidden />}
      <span className="sc-name">{t.name}</span>
      {showScore && <b>{t.score ?? '–'}</b>}
    </span>
  );
}

/** Horizontal strip of real games with live and final scores, refreshed every minute. */
export function ScoresRail({ tone = 'light', title = 'Scores' }: { tone?: 'light' | 'dark'; title?: string }) {
  const { data, failed } = useScoreboard();
  const leagues = useMemo(() => ['All', ...new Set((data?.games ?? []).map((g) => g.league))], [data]);
  const [league, setLeague] = useState('All');
  const games = (data?.games ?? []).filter((g) => league === 'All' || g.league === league).slice(0, 24);
  const liveCount = (data?.games ?? []).filter((g) => g.status === 'live').length;

  if (failed && !data) return null;

  return (
    <section className={`scores ${tone}`} aria-labelledby="scores-title">
      <div className="sc-head">
        <h2 id="scores-title">
          {liveCount > 0 && (
            <span className="live">
              Live <i />
            </span>
          )}
          {title}
        </h2>
        <div className="sc-leagues" role="tablist" aria-label="League">
          {leagues.map((l) => (
            <button key={l} type="button" role="tab" aria-selected={league === l} className={league === l ? 'on' : ''} onClick={() => setLeague(l)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="sc-rail" aria-busy={!data}>
        {!data &&
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="sc-card skeleton">
              <span className="sk" />
              <span className="sk" />
            </div>
          ))}
        {data && games.length === 0 && <p className="sc-empty">No games in the feed right now.</p>}
        {games.map((g) => {
          const started = g.status === 'live' || g.status === 'final';
          const hs = g.home.score ?? -1;
          const as = g.away.score ?? -1;
          return (
            <article key={g.id} className={`sc-card ${g.status}`}>
              <header>
                <span className="sc-league">{g.league}</span>
                <span className="sc-status">
                  {g.status === 'live' ? g.progress ?? 'Live' : g.status === 'final' ? (g.statusText && g.statusText !== 'FT' && g.statusText !== 'Match Finished' ? `Final ${g.statusText}` : 'Final') : g.status === 'postponed' ? 'Postponed' : g.status === 'cancelled' ? 'Cancelled' : time(g.startsAt)}
                </span>
              </header>
              <Team t={g.away} lead={started && as > hs} showScore={started} />
              <Team t={g.home} lead={started && hs > as} showScore={started} />
            </article>
          );
        })}
      </div>
      <p className="sc-foot">
        {data && !data.live ? 'Final scores update every few minutes. ' : ''}Data from{' '}
        <a href="https://www.thesportsdb.com" target="_blank" rel="noreferrer">
          TheSportsDB
        </a>
      </p>
    </section>
  );
}
