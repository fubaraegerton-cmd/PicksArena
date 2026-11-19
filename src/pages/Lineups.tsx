import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import type { Entry } from '../types';
import { money } from '../lib/format';
import { payoutTiers } from '../lib/payouts';
import { haptic } from '../lib/device';
import { Icon } from '../components/Icon';
import { Jersey } from '../components/ProjectionCard';

function EntryTicket({ entry, onSettle, ready }: { entry: Entry; onSettle: () => void; ready: boolean }) {
  const n = entry.picks.length;
  const hits = entry.picks.filter((p) => p.result === 'hit').length;
  const open = entry.status === 'open';
  return (
    <article className={`entry ${entry.status}`}>
      <header className="entry-head">
        <div>
          <p className="eyebrow">
            {n}-pick {entry.playType} · #{entry.id.slice(-5)}
          </p>
          <p className="entry-date">
            {new Date(entry.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </p>
        </div>
        {!open && <span className={`stamp ${entry.status}`}>{entry.status === 'won' ? 'Won' : entry.status === 'refunded' ? 'Refunded' : 'Lost'}</span>}
        {open && <span className="live-dot">Open</span>}
      </header>

      <div className="entry-figures">
        <div>
          <span className="eyebrow">Entry</span>
          <strong>{money(entry.amount)}</strong>
        </div>
        <div>
          <span className="eyebrow">{open ? 'Pays up to' : 'Paid'}</span>
          <strong className={entry.status === 'won' ? 'pos' : ''}>
            {money(open ? entry.potentialPayout : entry.payout)}
          </strong>
        </div>
        {!open && (
          <div>
            <span className="eyebrow">Hit</span>
            <strong>
              {hits}/{n}
            </strong>
          </div>
        )}
      </div>

      <div className="hitstrip" aria-hidden>
        {entry.picks.map((p) => (
          <span key={p.projection.id} className={p.result} />
        ))}
      </div>

      <ul className="entry-picks">
        {entry.picks.map((p) => (
          <li key={p.projection.id} className={p.result}>
            <Jersey color={p.projection.player.team.color} number={p.projection.player.number} size="sm" />
            <div className="tk-info">
              <strong>{p.projection.player.name}</strong>
              <span>
                {p.projection.player.team.abbr} vs {p.projection.opponent.abbr} · {p.projection.statType}
              </span>
            </div>
            <div className="ep-call">
              <span className={`call ${p.direction}`}>
                <Icon name={p.direction === 'more' ? 'up' : 'down'} size={13} strokeWidth={3} />
                {p.projection.line}
              </span>
              {p.actual !== undefined && <span className="final">Final {p.actual}</span>}
            </div>
            <span className="ep-res" aria-label={p.result}>
              {p.result === 'hit' ? (
                <Icon name="check" size={16} strokeWidth={3} />
              ) : p.result === 'miss' ? (
                <Icon name="close" size={14} strokeWidth={3} />
              ) : p.result === 'push' || p.result === 'void' ? (
                <span className="ep-note">{p.result === 'push' ? 'Push' : 'Void'}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>

      {entry.playType === 'flex' && open && (
        <p className="fine left">
          Pays {payoutTiers('flex', n).map((t) => `${t.hits}/${n} → ${t.mult}×`).join(' · ')}
        </p>
      )}

      {open && !ready && (
        <p className="waiting">
          <Icon name="shield" size={15} />
          Waiting on official results from the house
        </p>
      )}

      {open && ready && (
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            haptic([10, 30, 10]);
            onSettle();
          }}
        >
          <Icon name="bolt" size={16} />
          Simulate final stats
        </button>
      )}
    </article>
  );
}

export function Lineups() {
  const { entries, settle, settleAll, canSettle } = useStore();
  const [tab, setTab] = useState<'open' | 'settled'>('open');
  const open = entries.filter((e) => e.status === 'open');
  const settled = entries.filter((e) => e.status !== 'open');
  const list = tab === 'open' ? open : settled;

  const wagered = settled.reduce((s, e) => s + e.amount, 0);
  const won = settled.reduce((s, e) => s + e.payout, 0);
  const net = won - wagered;
  const winRate = settled.length ? Math.round((settled.filter((e) => e.status === 'won').length / settled.length) * 100) : 0;

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">Your entries</p>
        <h1>Lineups</h1>
      </header>

      <div className="kpis">
        <div>
          <span className="eyebrow">Entries</span>
          <strong>{entries.length}</strong>
        </div>
        <div>
          <span className="eyebrow">Win rate</span>
          <strong>{winRate}%</strong>
        </div>
        <div>
          <span className="eyebrow">Net</span>
          <strong className={net > 0 ? 'pos' : net < 0 ? 'neg' : ''}>{money(net)}</strong>
        </div>
      </div>

      <div className="tabbar-row">
        <div className="seg seg-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>
            Open <span className="cnt">{open.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'settled'} className={tab === 'settled' ? 'on' : ''} onClick={() => setTab('settled')}>
            Settled <span className="cnt">{settled.length}</span>
          </button>
        </div>
        {tab === 'open' && open.filter(canSettle).length > 1 && (
          <button type="button" className="text-btn" onClick={() => { haptic([10, 30, 10]); settleAll(); }}>
            Simulate all
          </button>
        )}
      </div>

      {list.length === 0 ? (
        <div className="empty">
          {tab === 'open' ? (
            <>
              <p>No open entries.</p>
              <Link to="/board" className="text-btn">
                Build a ticket <Icon name="arrow" size={16} />
              </Link>
            </>
          ) : (
            <p>Settled entries will show up here.</p>
          )}
        </div>
      ) : (
        <div className="entries">
          {list.map((e) => (
            <EntryTicket key={e.id} entry={e} ready={canSettle(e)} onSettle={() => settle(e.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
