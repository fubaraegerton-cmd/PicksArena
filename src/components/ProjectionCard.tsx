import { memo } from 'react';
import type { Direction, Projection } from '../types';
import { countdown, gameTime, initials } from '../lib/format';

interface Props {
  projection: Projection;
  selected?: Direction;
  now: number;
  onPick: (id: string, d: Direction) => void;
}

function ProjectionCardBase({ projection: p, selected, now, onPick }: Props) {
  const started = p.game.startsAt <= now;
  const cd = countdown(p.game.startsAt, now);
  const isHome = p.game.home.abbr === p.player.team.abbr;
  return (
    <article className={`card proj ${selected ? 'is-selected' : ''}`} aria-label={`${p.player.name} ${p.line} ${p.statType}`}>
      {p.tag && (
        <span className={`tag tag-${p.tag}`}>{p.tag === 'hot' ? '🔥 Popular' : '📈 Trending'}</span>
      )}
      <div className="avatar" style={{ '--team': p.player.team.color } as React.CSSProperties}>
        {initials(p.player.name)}
      </div>
      <div className="proj-meta">
        <span className="team-chip" style={{ background: p.player.team.color }}>
          {p.player.team.abbr}
        </span>
        <span className="muted">· {p.player.position}</span>
      </div>
      <h3 className="proj-name">{p.player.name}</h3>
      <p className="muted small">
        {isHome ? 'vs' : '@'} {p.opponent.abbr} · {cd && !started ? <span className="soon">{cd}</span> : gameTime(p.game.startsAt, now)}
      </p>
      <div className="line">
        <strong>{p.line}</strong>
        <span>{p.statType}</span>
      </div>
      <div className="split">
        <button
          type="button"
          className={`pick-btn less ${selected === 'less' ? 'on' : ''}`}
          disabled={started}
          aria-pressed={selected === 'less'}
          onClick={() => onPick(p.id, 'less')}
        >
          ↓ Less
        </button>
        <button
          type="button"
          className={`pick-btn more ${selected === 'more' ? 'on' : ''}`}
          disabled={started}
          aria-pressed={selected === 'more'}
          onClick={() => onPick(p.id, 'more')}
        >
          ↑ More
        </button>
      </div>
      <div className="share" title="Share of entries picking More">
        <div className="share-bar">
          <span style={{ width: `${p.moreShare}%` }} />
        </div>
        <span className="muted tiny">{p.moreShare}% More</span>
      </div>
    </article>
  );
}

export const ProjectionCard = memo(ProjectionCardBase);
