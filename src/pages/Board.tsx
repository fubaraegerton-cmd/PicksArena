import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { SPORTS } from '../data/sports';
import type { SportId } from '../types';
import { ProjectionCard } from '../components/ProjectionCard';
import { Slip } from '../components/Slip';
import { maxMultiplier } from '../lib/payouts';

type Sort = 'time' | 'popular' | 'name';

export function Board() {
  const { board, picks, now, togglePick, playType } = useStore();
  const [params, setParams] = useSearchParams();
  const sport = (params.get('sport') as SportId) || 'NBA';
  const [stat, setStat] = useState<string>('All');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('time');
  const [sheetOpen, setSheetOpen] = useState(false);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of board) c[p.player.sport] = (c[p.player.sport] ?? 0) + 1;
    return c;
  }, [board]);

  const sportBoard = useMemo(() => board.filter((p) => p.player.sport === sport), [board, sport]);
  const statTypes = useMemo(() => {
    const freq = new Map<string, number>();
    sportBoard.forEach((p) => freq.set(p.statType, (freq.get(p.statType) ?? 0) + 1));
    return ['All', ...[...freq.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)];
  }, [sportBoard]);

  const activeStat = statTypes.includes(stat) ? stat : 'All';

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = sportBoard.filter(
      (p) =>
        (activeStat === 'All' || p.statType === activeStat) &&
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
  }, [sportBoard, activeStat, query, sort]);

  const selectedMap = useMemo(() => new Map(picks.map((p) => [p.projectionId, p.direction])), [picks]);

  return (
    <div className="board-layout">
      <section className="board-main">
        <div className="hero">
          <div>
            <h1>Pick More or Less. Win up to {maxMultiplier('power', 6)}x.</h1>
            <p className="muted">Choose 2–6 player projections, then decide whether each will go over or under the line.</p>
          </div>
        </div>

        <nav className="sports" aria-label="Sports">
          {SPORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`sport ${sport === s.id ? 'on' : ''}`}
              onClick={() => {
                setParams({ sport: s.id });
                setStat('All');
              }}
            >
              <span className="sport-icon">{s.icon}</span>
              <span>{s.label}</span>
              <span className="badge">{counts[s.id] ?? 0}</span>
            </button>
          ))}
        </nav>

        <div className="toolbar">
          <div className="chips" role="tablist" aria-label="Stat types">
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
          <div className="toolbar-row">
            <input
              className="search"
              type="search"
              placeholder="Search players or teams"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
              <option value="time">Start time</option>
              <option value="popular">Popular</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="empty-state">No projections match your filters.</div>
        ) : (
          <div className="grid">
            {visible.map((p) => (
              <ProjectionCard
                key={p.id}
                projection={p}
                now={now}
                selected={selectedMap.get(p.id)}
                onPick={togglePick}
              />
            ))}
          </div>
        )}
      </section>

      <aside className="board-side">
        <Slip />
      </aside>

      {picks.length > 0 && (
        <button type="button" className="mobile-bar" onClick={() => setSheetOpen(true)}>
          <span className="count">{picks.length}</span>
          <span>View lineup</span>
          <span className="muted">
            {playType === 'power' ? 'Power' : 'Flex'} · up to {maxMultiplier(playType, picks.length) || '—'}x
          </span>
        </button>
      )}

      {sheetOpen && (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Lineup">
            <button type="button" className="sheet-close" onClick={() => setSheetOpen(false)} aria-label="Close">
              ×
            </button>
            <Slip onSubmitted={() => setSheetOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
