import { useMemo } from 'react';
import { useStore } from '../store';
import { MAX_PICKS, MIN_ENTRY, flexAvailable, maxMultiplier, payoutTiers, validateLineup } from '../lib/payouts';
import { initials, money } from '../lib/format';

const QUICK_AMOUNTS = [5, 10, 25, 50];

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

  if (n === 0) {
    return (
      <div className="slip empty">
        <div className="slip-empty-icon">🎯</div>
        <h3>Build your lineup</h3>
        <p className="muted">
          Pick <strong>More</strong> or <strong>Less</strong> on 2–{MAX_PICKS} player projections. Get them right
          to win up to <strong>{maxMultiplier('power', MAX_PICKS)}x</strong> your entry.
        </p>
      </div>
    );
  }

  return (
    <div className="slip">
      <header className="slip-head">
        <h3>
          Current lineup <span className="count">{n}</span>
        </h3>
        <button type="button" className="link" onClick={clearPicks}>
          Clear
        </button>
      </header>

      <ul className="slip-list">
        {picks.map((pk) => {
          const p = byId.get(pk.projectionId);
          if (!p) return null;
          return (
            <li key={pk.projectionId} className="slip-item">
              <div className="avatar sm" style={{ '--team': p.player.team.color } as React.CSSProperties}>
                {initials(p.player.name)}
              </div>
              <div className="slip-info">
                <strong>{p.player.name}</strong>
                <span className="muted small">
                  {p.player.team.abbr} · {p.line} {p.statType}
                </span>
              </div>
              <div className="mini-toggle" role="group" aria-label="Direction">
                <button
                  type="button"
                  className={pk.direction === 'less' ? 'on less' : ''}
                  onClick={() => pk.direction !== 'less' && togglePick(p.id, 'less')}
                >
                  Less
                </button>
                <button
                  type="button"
                  className={pk.direction === 'more' ? 'on more' : ''}
                  onClick={() => pk.direction !== 'more' && togglePick(p.id, 'more')}
                >
                  More
                </button>
              </div>
              <button type="button" className="x" aria-label={`Remove ${p.player.name}`} onClick={() => removePick(p.id)}>
                ×
              </button>
            </li>
          );
        })}
      </ul>

      <div className="playtype" role="radiogroup" aria-label="Play type">
        <button
          type="button"
          role="radio"
          aria-checked={playType === 'power'}
          className={playType === 'power' ? 'on' : ''}
          onClick={() => setPlayType('power')}
        >
          <strong>Power Play</strong>
          <span>All picks must hit</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={playType === 'flex'}
          disabled={!flexAvailable(n)}
          className={playType === 'flex' ? 'on' : ''}
          onClick={() => setPlayType('flex')}
          title={flexAvailable(n) ? '' : 'Add at least 3 picks for Flex'}
        >
          <strong>Flex Play</strong>
          <span>{flexAvailable(n) ? 'Win even with a miss' : 'Needs 3+ picks'}</span>
        </button>
      </div>

      {tiers.length > 0 && (
        <div className="tiers">
          {tiers.map((t) => (
            <div key={t.hits} className="tier">
              <span>
                {t.hits}/{n} correct
              </span>
              <strong>{t.mult}x</strong>
              <span className="muted">{money(amount * t.mult)}</span>
            </div>
          ))}
        </div>
      )}

      <label className="amount">
        <span className="muted small">Entry amount</span>
        <div className="amount-row">
          <span className="dollar">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={MIN_ENTRY}
            step="1"
            value={Number.isFinite(amount) ? amount : ''}
            onChange={(e) => setAmount(e.target.value === '' ? NaN : Number(e.target.value))}
          />
        </div>
      </label>
      <div className="quick">
        {QUICK_AMOUNTS.map((q) => (
          <button key={q} type="button" className={amount === q ? 'on' : ''} onClick={() => setAmount(q)}>
            ${q}
          </button>
        ))}
      </div>

      <div className="to-win">
        <span>To win</span>
        <strong>{mult && Number.isFinite(amount) ? money(amount * mult) : '—'}</strong>
      </div>

      {!validation.ok && <p className="slip-error">{validation.errors[0]}</p>}

      <button
        type="button"
        className="btn primary block"
        disabled={!validation.ok}
        onClick={() => {
          if (submit()) onSubmitted?.();
        }}
      >
        Place entry
      </button>
      <p className="muted tiny center">Demo credits only — no real money involved.</p>
    </div>
  );
}
