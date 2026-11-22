import { memo, type CSSProperties } from 'react';
import type { Direction, Projection } from '../types';
import { countdown, gameTime } from '../lib/format';
import { haptic } from '../lib/device';
import { Icon } from './Icon';

interface Props {
  projection: Projection;
  selected?: Direction;
  now: number;
  onPick: (id: string, d: Direction) => void;
}

export function Jersey({ color, number, size = 'md' }: { color: string; number?: number; size?: 'sm' | 'md' }) {
  return (
    <span className={`jersey jersey-${size}`} style={{ '--team': color } as CSSProperties} aria-hidden>
      {number ?? ''}
    </span>
  );
}

function ProjectionCardBase({ projection: p, selected, now, onPick }: Props) {
  const started = p.game.startsAt <= now;
  const tiered = !!p.tier && p.tier !== 'standard';
  const soon = countdown(p.game.startsAt, now);
  const isHome = p.game.home.abbr === p.player.team.abbr;
  const pick = (d: Direction) => {
    haptic(selected === d ? 4 : 10);
    onPick(p.id, d);
  };

  return (
    <article
      className={`pcard ${selected ? `is-${selected}` : ''} ${p.special ? 'is-special' : ''} ${tiered ? `tier-${p.tier}` : ''}`}
      style={{ '--team': p.player.team.color } as CSSProperties}
      aria-label={`${p.player.name}, ${p.line} ${p.statType}`}
    >
      <div className="pcard-top">
        <div className="pcard-who">
          <div className="pcard-meta">
            <span className="team-abbr">{p.player.team.abbr}</span>
            <span>{p.player.position}</span>
            {tiered && (
              <span className={`flag flag-${p.tier}`} title={p.tier === 'venom' ? 'Harder line, bigger payout. More only.' : 'Easier line, smaller payout. More only.'}>
                {p.tier === 'venom' ? 'Venom' : 'Shield'} ×{p.payoutFactor}
              </span>
            )}
            {p.special && (
              <span className="flag flag-special">
                <Icon name="star" size={11} strokeWidth={2.5} />
                Special
              </span>
            )}
            {p.tag && (
              <span className={`flag flag-${p.tag}`}>
                <Icon name={p.tag === 'hot' ? 'flame' : 'trend'} size={11} strokeWidth={2.5} />
                {p.tag === 'hot' ? 'Hot' : 'Moving'}
              </span>
            )}
          </div>
          <h3 className="pcard-name">{p.player.name}</h3>
          <p className="pcard-game">
            <span>
              {isHome ? 'vs' : '@'} {p.opponent.abbr}
            </span>
            <span className="dot" />
            {soon && !started ? <span className="soon">{soon}</span> : <span>{gameTime(p.game.startsAt, now)}</span>}
          </p>
        </div>
        <Jersey color={p.player.team.color} number={p.player.number} />
      </div>

      <div className="pcard-line">
        <span className="num">{p.line}</span>
        <span className="stat">{p.statType}</span>
      </div>

      {p.note && <p className="pcard-note">“{p.note}”</p>}

      <div className="pcard-pct" title="Share of entries picking More">
        <span className="bar">
          <i style={{ width: `${p.moreShare}%` }} />
        </span>
        <span>{p.moreShare}% more</span>
      </div>

      <div className={`pcard-actions ${tiered ? 'single' : ''}`} role="group" aria-label="Pick direction">
        {!tiered && (
        <button
          type="button"
          className={`pick less ${selected === 'less' ? 'on' : ''}`}
          disabled={started}
          aria-pressed={selected === 'less'}
          onClick={() => pick('less')}
        >
          <Icon name="down" size={16} strokeWidth={2.75} />
          Less
        </button>
        )}
        <button
          type="button"
          className={`pick more ${selected === 'more' ? 'on' : ''}`}
          disabled={started}
          aria-pressed={selected === 'more'}
          onClick={() => pick('more')}
        >
          {tiered ? `More only, ×${p.payoutFactor}` : 'More'}
          <Icon name="up" size={16} strokeWidth={2.75} />
        </button>
      </div>
    </article>
  );
}

export const ProjectionCard = memo(ProjectionCardBase);
