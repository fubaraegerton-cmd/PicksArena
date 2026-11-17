import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import type { Entry } from '../types';
import { initials, money } from '../lib/format';
import { payoutTiers } from '../lib/payouts';

function EntryCard({ entry, onSettle }: { entry: Entry; onSettle: () => void }) {
  const n = entry.picks.length;
  const hits = entry.picks.filter((p) => p.result === 'hit').length;
  return (
    <article className={`card entry status-${entry.status}`}>
      <header className="entry-head">
        <div>
          <strong>
            {n}-Pick {entry.playType === 'power' ? 'Power' : 'Flex'} Play
          </strong>
          <span className="muted small">
            {' '}
            · {new Date(entry.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
        </div>
        <span className={`status-pill ${entry.status}`}>
          {entry.status === 'open' ? 'Open' : entry.status === 'won' ? 'Won' : 'Lost'}
        </span>
      </header>

      <div className="entry-money">
        <div>
          <span className="muted small">Entry</span>
          <strong>{money(entry.amount)}</strong>
        </div>
        <div>
          <span className="muted small">{entry.status === 'open' ? 'To win' : 'Payout'}</span>
          <strong className={entry.status === 'won' ? 'pos' : ''}>
            {money(entry.status === 'open' ? entry.potentialPayout : entry.payout)}
          </strong>
        </div>
        {entry.status !== 'open' && (
          <div>
            <span className="muted small">Correct</span>
            <strong>
              {hits}/{n}
            </strong>
          </div>
        )}
      </div>

      <ul className="entry-picks">
        {entry.picks.map((p) => (
          <li key={p.projection.id} className={`res-${p.result}`}>
            <div className="avatar sm" style={{ '--team': p.projection.player.team.color } as React.CSSProperties}>
              {initials(p.projection.player.name)}
            </div>
            <div className="slip-info">
              <strong>{p.projection.player.name}</strong>
              <span className="muted small">
                {p.projection.player.team.abbr} vs {p.projection.opponent.abbr} · {p.projection.statType}
              </span>
            </div>
            <div className="pick-detail">
              <span className={`dir ${p.direction}`}>
                {p.direction === 'more' ? '↑ More' : '↓ Less'} {p.projection.line}
              </span>
              {p.actual !== undefined && <span className="actual">Final: {p.actual}</span>}
            </div>
            <span className="res-icon" aria-label={p.result}>
              {p.result === 'hit' ? '✓' : p.result === 'miss' ? '✕' : '•'}
            </span>
          </li>
        ))}
      </ul>

      {entry.playType === 'flex' && entry.status === 'open' && (
        <p className="muted tiny">
          Pays:{' '}
          {payoutTiers('flex', n)
            .map((t) => `${t.hits}/${n} → ${t.mult}x`)
            .join(' · ')}
        </p>
      )}

      {entry.status === 'open' && (
        <button type="button" className="btn ghost block" onClick={onSettle}>
          ⚡ Simulate results
        </button>
      )}
    </article>
  );
}

export function Lineups() {
  const { entries, settle, settleAll } = useStore();
  const [tab, setTab] = useState<'open' | 'settled'>('open');
  const open = entries.filter((e) => e.status === 'open');
  const settled = entries.filter((e) => e.status !== 'open');
  const list = tab === 'open' ? open : settled;

  const wagered = settled.reduce((s, e) => s + e.amount, 0);
  const won = settled.reduce((s, e) => s + e.payout, 0);
  const winRate = settled.length ? Math.round((settled.filter((e) => e.status === 'won').length / settled.length) * 100) : 0;

  return (
    <div className="page">
      <h1>My Lineups</h1>

      <div className="stats-row">
        <div className="stat">
          <span className="muted small">Entries</span>
          <strong>{entries.length}</strong>
        </div>
        <div className="stat">
          <span className="muted small">Win rate</span>
          <strong>{winRate}%</strong>
        </div>
        <div className="stat">
          <span className="muted small">Net</span>
          <strong className={won - wagered >= 0 ? 'pos' : 'neg'}>{money(won - wagered)}</strong>
        </div>
      </div>

      <div className="tabs">
        <button type="button" className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>
          Open <span className="badge">{open.length}</span>
        </button>
        <button type="button" className={tab === 'settled' ? 'on' : ''} onClick={() => setTab('settled')}>
          Completed <span className="badge">{settled.length}</span>
        </button>
        {tab === 'open' && open.length > 1 && (
          <button type="button" className="link right" onClick={settleAll}>
            Simulate all
          </button>
        )}
      </div>

      {list.length === 0 ? (
        <div className="empty-state">
          {tab === 'open' ? (
            <>
              No open lineups. <Link to="/">Build one on the board →</Link>
            </>
          ) : (
            'No completed lineups yet.'
          )}
        </div>
      ) : (
        <div className="entries">
          {list.map((e) => (
            <EntryCard key={e.id} entry={e} onSettle={() => settle(e.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
