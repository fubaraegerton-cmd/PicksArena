import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { SPORTS } from '../data/sports';
import { PLAY_SPORTS } from '../lib/supabase';
import type { SportId } from '../types';
import { ProjectionCard } from '../components/ProjectionCard';
import { Slip } from '../components/Slip';
import { BottomSheet } from '../components/BottomSheet';
import { Icon } from '../components/Icon';
import { entryMultiplier, maxMultiplier } from '../lib/payouts';
import { gameTime, money } from '../lib/format';
import { haptic } from '../lib/device';

type Sort = 'time' | 'popular' | 'name';

export function Board() {
  const { board, picks, now, togglePick, playType, amount } = useStore();
  const [params, setParams] = useSearchParams();
  const specialCount = useMemo(() => board.filter((p) => p.special).length, [board]);
  const param = params.get('sport');
  const isSpecials = specialCount > 0 && (param === 'SPECIALS' || !param);
  const sport = (SPORTS.some((s) => s.id === param) ? param : 'NBA') as SportId;
  const [stat, setStat] = useState('All');
  const [gameId, setGameId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('time');
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of board) c[p.player.sport] = (c[p.player.sport] ?? 0) + 1;
    return c;
  }, [board]);

  const sportBoard = useMemo(
    () => (isSpecials ? board.filter((p) => p.special) : board.filter((p) => p.player.sport === sport)),
    [board, sport, isSpecials],
  );

  const games = useMemo(() => {
    const m = new Map<string, (typeof sportBoard)[number]['game']>();
    sportBoard.forEach((p) => m.set(p.game.id, p.game));
    return [...m.values()].sort((a, b) => a.startsAt - b.startsAt);
  }, [sportBoard]);

  const statTypes = useMemo(() => {
    const freq = new Map<string, number>();
    sportBoard.forEach((p) => freq.set(p.statType, (freq.get(p.statType) ?? 0) + 1));
    const tiered = sportBoard.some((p) => p.tier && p.tier !== 'standard');
    return ['All', ...(tiered ? ['Venom & Shield'] : []), ...[...freq.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)];
  }, [sportBoard]);
  const activeStat = statTypes.includes(stat) ? stat : 'All';
  const activeGame = games.some((g) => g.id === gameId) ? gameId : null;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = sportBoard.filter(
      (p) =>
        (activeStat === 'All' || (activeStat === 'Venom & Shield' ? !!p.tier && p.tier !== 'standard' : p.statType === activeStat)) &&
        (!activeGame || p.game.id === activeGame) &&
        (!q ||
          p.player.name.toLowerCase().includes(q) ||
          p.player.team.abbr.toLowerCase().includes(q) ||
          p.player.team.name.toLowerCase().includes(q)),
    );
    const sorted = [...list];
    if (sort === 'time') sorted.sort((a, b) => a.game.startsAt - b.game.startsAt || a.player.name.localeCompare(b.player.name));
    if (sort === 'popular') sorted.sort((a, b) => Number(!!b.tag) - Number(!!a.tag) || b.moreShare - a.moreShare);
    if (sort === 'name') sorted.sort((a, b) => a.player.name.localeCompare(b.player.name));
    return sorted;
  }, [sportBoard, activeStat, activeGame, query, sort]);

  const selectedMap = useMemo(() => new Map(picks.map((p) => [p.projectionId, p.direction])), [picks]);
  const { byId, realMoney, boardLoaded } = useStore();
  const mult = playType === 'power' ? entryMultiplier(picks.map((p) => byId.get(p.projectionId)!).filter(Boolean)) : maxMultiplier(playType, picks.length);

  const changeSport = (id: SportId | 'SPECIALS') => {
    haptic(6);
    setParams({ sport: id }, { replace: true });
    setStat('All');
    setGameId(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="board">
      <section className="board-main">
        <header className="page-head">
          <h1>{isSpecials ? 'Specials' : `${PLAY_SPORTS.find((s) => s.id === sport)?.label ?? sport} board`}</h1>
          <p className="page-sub">
            {isSpecials ? 'Hand-picked by the house' : `${sportBoard.length} lines across ${games.length} ${games.length === 1 ? 'game' : 'games'}`}
          </p>
        </header>

        <div className="board-sticky">
          <nav className="sport-tabs" aria-label="Sports">
            {specialCount > 0 && (
              <button
                type="button"
                aria-current={isSpecials ? 'page' : undefined}
                className={`specials-tab ${isSpecials ? 'on' : ''}`}
                onClick={() => changeSport('SPECIALS')}
              >
                <Icon name="star" size={15} strokeWidth={2.5} />
                Specials
                <span className="cnt">{specialCount}</span>
              </button>
            )}
            {PLAY_SPORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-current={!isSpecials && sport === s.id ? 'page' : undefined}
                className={!isSpecials && sport === s.id ? 'on' : ''}
                onClick={() => changeSport(s.id)}
              >
                {s.label}
                <span className="cnt">{counts[s.id] ?? 0}</span>
              </button>
            ))}
          </nav>

          <div className="filters">
            <div className="scroller stat-chips" role="tablist" aria-label="Stat type">
              {statTypes.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={activeStat === s}
                  className={`chip ${activeStat === s ? 'on' : ''}`}
                  onClick={() => setStat(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="scroller games" aria-label="Games">
          <button
            type="button"
            className={`game-chip all ${!activeGame ? 'on' : ''}`}
            onClick={() => setGameId(null)}
          >
            <span className="g-teams">All games</span>
            <span className="g-time">{games.length} matchups</span>
          </button>
          {games.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`game-chip ${activeGame === g.id ? 'on' : ''}`}
              onClick={() => setGameId(activeGame === g.id ? null : g.id)}
            >
              <span className="g-teams">
                <i style={{ background: g.away.color }} />
                {g.away.abbr}
                <span className="at">@</span>
                <i style={{ background: g.home.color }} />
                {g.home.abbr}
              </span>
              <span className="g-time">{gameTime(g.startsAt, now)}</span>
            </button>
          ))}
        </div>

        <div className="toolbar">
          <label className="search">
            <Icon name="search" size={18} />
            <input
              type="search"
              placeholder="Search players"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              enterKeyHint="search"
            />
          </label>
          <label className="select">
            <span className="sr">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="time">Start time</option>
              <option value="popular">Popular</option>
              <option value="name">A–Z</option>
            </select>
          </label>
        </div>

        {realMoney && !boardLoaded && visible.length === 0 ? (
          <div className="grid" aria-busy="true" aria-label="Loading the board">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="pcard skeleton">
                <span className="sk sk-meta" />
                <span className="sk sk-name" />
                <span className="sk sk-line" />
                <span className="sk sk-btns" />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <p>No projections match.</p>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                setQuery('');
                setStat('All');
                setGameId(null);
              }}
            >
              Reset filters
            </button>
          </div>
        ) : (
          <div className="grid">
            {visible.map((p) => (
              <ProjectionCard key={p.id} projection={p} now={now} selected={selectedMap.get(p.id)} onPick={togglePick} />
            ))}
          </div>
        )}
      </section>

      <aside className="board-side" aria-label="Entry ticket">
        <Slip />
      </aside>

      {picks.length > 0 && !sheetOpen && (
        <button type="button" className="ticket-bar" onClick={() => { haptic(8); setSheetOpen(true); }}>
          <span className="tb-count">{picks.length}</span>
          <span className="tb-text">
            <strong>View ticket</strong>
            <span>
              {playType === 'power' ? 'Power' : 'Flex'} · {mult ? `${mult}×` : 'add 1 more'}
            </span>
          </span>
          <span className="tb-pay">{mult && Number.isFinite(amount) ? money(amount * mult) : ''}</span>
          <Icon name="up" size={18} strokeWidth={2.5} />
        </button>
      )}

      <BottomSheet open={sheetOpen} onClose={closeSheet} label="Entry ticket">
        <Slip onSubmitted={closeSheet} />
      </BottomSheet>
    </div>
  );
}
