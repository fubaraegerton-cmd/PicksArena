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
      <header className="pc-head">
        <span className="pc-team">
          <i className="pc-dot" aria-hidden />
          {p.player.team.abbr}
          <span className="pc-sep">·</span>
          {p.player.position}
          {p.player.number !== undefined && <span className="pc-num">#{p.player.number}</span>}
        </span>
        <span className={`pc-time ${soon && !started ? 'soon' : ''}`}>{soon && !started ? soon : gameTime(p.game.startsAt, now)}</span>
      </header>

      <div className="pc-body">
        <div className="pc-who">
          <h3 className="pc-name">{p.player.name}</h3>
          <p className="pc-sub">
            {isHome ? 'vs' : '@'} {p.opponent.abbr}
            <span className="pc-sep">·</span>
            <span title="Share of entries picking More">{p.moreShare}% more</span>
          </p>
          {(tiered || p.special || p.tag) && (
            <p className="pc-tags">
              {tiered && (
                <span className={`tag tag-${p.tier}`} title={p.tier === 'venom' ? 'Harder line, bigger payout. More only.' : 'Easier line, smaller payout. More only.'}>
                  {p.tier === 'venom' ? 'Venom' : 'Shield'} ×{p.payoutFactor}
                </span>
              )}
              {p.special && (
                <span className="tag tag-special">
                  <Icon name="star" size={12} strokeWidth={2} />
                  Special
                </span>
              )}
              {p.tag && (
                <span className="tag">
                  <Icon name={p.tag === 'hot' ? 'flame' : 'trend'} size={12} strokeWidth={2} />
                  {p.tag === 'hot' ? 'Popular' : 'Line moved'}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="pc-line">
          <span className="num">{p.line}</span>
          <span className="stat">{p.statType}</span>
        </div>
      </div>

      {p.note && <p className="pc-note">{p.note}</p>}

      <div className={`pc-pick ${tiered ? 'single' : ''}`} role="group" aria-label="Pick direction">
        {!tiered && (
          <button
            type="button"
            className={`pick less ${selected === 'less' ? 'on' : ''}`}
            disabled={started}
            aria-pressed={selected === 'less'}
            onClick={() => pick('less')}
          >
            <Icon name="down" size={16} strokeWidth={2.25} />
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
          <Icon name="up" size={16} strokeWidth={2.25} />
          {tiered ? `More only · pays ×${p.payoutFactor}` : 'More'}
        </button>
      </div>
    </article>
  );
}

export const ProjectionCard = memo(ProjectionCardBase);
