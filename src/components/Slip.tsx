import { useMemo } from 'react';
import { useStore } from '../store';
import { MAX_PICKS, MIN_ENTRY, MAX_ENTRY, flexAvailable, maxMultiplier, payoutTiers, validateLineup } from '../lib/payouts';
import { money } from '../lib/format';
import { haptic } from '../lib/device';
import { Icon } from './Icon';
import { Jersey } from './ProjectionCard';

const QUICK = [5, 10, 25, 50];

export function Slip({ onSubmitted }: { onSubmitted?: () => void }) {
  const {
    picks, byId, playType, amount, balance, now,
    togglePick, removePick, clearPicks, setPlayType, setAmount, submit,
  } = useStore();

  const n = picks.length;
  const validation = useMemo(
    () => validateLineup(picks, byId, playType, amount, balance, now),
    [picks, byId, playType, amount, balance, now],
  );
  const mult = maxMultiplier(playType, n);
  const tiers = payoutTiers(playType, n);
  const safeAmount = Number.isFinite(amount) ? amount : 0;

  if (n === 0) {
    return (
      <div className="ticket ticket-empty">
        <p className="eyebrow">Entry ticket</p>
        <div className="empty-arrows" aria-hidden>
          <Icon name="up" size={28} strokeWidth={3} />
          <Icon name="down" size={28} strokeWidth={3} />
        </div>
        <h3>Your ticket is empty</h3>
        <p className="muted">
          Call <b>More</b> or <b>Less</b> on 2–{MAX_PICKS} players. Hit them all to win up to{' '}
          <b>{maxMultiplier('power', MAX_PICKS)}×</b>.
        </p>
      </div>
    );
  }

  return (
    <div className="ticket">
      <header className="ticket-head">
        <div>
          <p className="eyebrow">Entry ticket</p>
          <h3>
            {n} pick{n > 1 ? 's' : ''}
            <span className="muted"> / {MAX_PICKS}</span>
          </h3>
        </div>
        <button type="button" className="text-btn" onClick={() => { haptic(6); clearPicks(); }}>
          Clear all
        </button>
      </header>

      <ul className="tk-picks">
        {picks.map((pk) => {
          const p = byId.get(pk.projectionId);
          if (!p) return null;
          return (
            <li key={pk.projectionId} className="tk-pick">
              <Jersey color={p.player.team.color} number={p.player.number} size="sm" />
              <div className="tk-info">
                <strong>{p.player.name}</strong>
                <span>
                  <b className="tk-line">{p.line}</b> {p.statType}
                </span>
              </div>
              <div className="seg seg-sm" role="group" aria-label={`${p.player.name} direction`}>
                <button
                  type="button"
                  className={pk.direction === 'less' ? 'on less' : ''}
                  aria-pressed={pk.direction === 'less'}
                  onClick={() => pk.direction !== 'less' && (haptic(8), togglePick(p.id, 'less'))}
                >
                  <Icon name="down" size={14} strokeWidth={3} />
                  <span className="sr">Less</span>
                </button>
                <button
                  type="button"
                  className={pk.direction === 'more' ? 'on more' : ''}
                  aria-pressed={pk.direction === 'more'}
                  onClick={() => pk.direction !== 'more' && (haptic(8), togglePick(p.id, 'more'))}
                >
                  <Icon name="up" size={14} strokeWidth={3} />
                  <span className="sr">More</span>
                </button>
              </div>
              <button type="button" className="icon-btn" aria-label={`Remove ${p.player.name}`} onClick={() => removePick(p.id)}>
                <Icon name="close" size={16} />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="seg seg-play" role="radiogroup" aria-label="Play type">
        <button
          type="button"
          role="radio"
          aria-checked={playType === 'power'}
          className={playType === 'power' ? 'on' : ''}
          onClick={() => { haptic(6); setPlayType('power'); }}
        >
          Power
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={playType === 'flex'}
          className={playType === 'flex' ? 'on' : ''}
          disabled={!flexAvailable(n)}
          onClick={() => { haptic(6); setPlayType('flex'); }}
        >
          Flex
        </button>
      </div>
      <p className="play-hint">
        {playType === 'power'
          ? 'Every pick must hit. Biggest payout.'
          : 'Still pays if you miss one' + (n >= 5 ? ' or two.' : '.')}
        {!flexAvailable(n) && ' Add a 3rd pick to unlock Flex.'}
      </p>

      <div className="perf" aria-hidden />

      <dl className="tiers">
        {tiers.map((t) => (
          <div key={t.hits} className="tier">
            <dt>
              {t.hits} of {n} correct
            </dt>
            <dd>
              <span className="mult">{t.mult}×</span>
              <span className="amt">{money(safeAmount * t.mult)}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="stake">
        <label className="stake-field">
          <span className="eyebrow">Entry</span>
          <div className="stepper">
            <button
              type="button"
              aria-label="Decrease entry"
              onClick={() => setAmount(Math.max(MIN_ENTRY, Math.round(safeAmount) - 1))}
            >
              −
            </button>
            <span className="cur">$</span>
            <input
              type="number"
              inputMode="decimal"
              min={MIN_ENTRY}
              max={MAX_ENTRY}
              value={Number.isFinite(amount) ? amount : ''}
              onChange={(e) => setAmount(e.target.value === '' ? NaN : Number(e.target.value))}
              aria-label="Entry amount in dollars"
            />
            <button
              type="button"
              aria-label="Increase entry"
              onClick={() => setAmount(Math.min(MAX_ENTRY, Math.round(safeAmount) + 1))}
            >
              +
            </button>
          </div>
        </label>
        <div className="chips-row">
          {QUICK.map((q) => (
            <button key={q} type="button" className={`chip ${amount === q ? 'on' : ''}`} onClick={() => { haptic(4); setAmount(q); }}>
              ${q}
            </button>
          ))}
        </div>
      </div>

      <div className="payout">
        <span className="eyebrow">Pays up to</span>
        <span className="payout-num">{mult && safeAmount ? money(safeAmount * mult) : '—'}</span>
      </div>

      {!validation.ok && (
        <p className="ticket-error" role="alert">
          {validation.errors[0]}
        </p>
      )}

      <button
        type="button"
        className="cta"
        disabled={!validation.ok}
        onClick={() => {
          if (submit()) {
            haptic([12, 40, 18]);
            onSubmitted?.();
          }
        }}
      >
        <span>Place entry</span>
        <span className="cta-amt">{money(safeAmount)}</span>
      </button>
      <p className="fine">Play-money credits only. No real money.</p>
    </div>
  );
}
