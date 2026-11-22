import { useCallback, useEffect, useState } from 'react';
import { askConfirm } from '../components/NativeDialog';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { money } from '../lib/format';
import { exclude, getRg, setLimit, type LimitKind, type LimitPeriod, type RgLimit, type RgState } from '../lib/supabase';
import { Icon } from '../components/Icon';

const KIND_TITLE: Record<LimitKind, string> = { deposit: 'Deposit limit', stake: 'Stake limit', loss: 'Loss limit' };
const KIND_HELP: Record<LimitKind, string> = {
  deposit: 'The most you can add to your wallet.',
  stake: 'The most you can put into entries.',
  loss: 'The most you can lose: stakes minus what you win back.',
};
const PERIOD_TITLE: Record<LimitPeriod, string> = { day: '24 hours', week: '7 days', month: '30 days' };
const SUMMARY_TITLE = { day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days', all: 'All time' } as const;

export const REMINDER_KEY = 'picksarena:reality-check-minutes';
export function reminderMinutes(): number {
  try {
    const v = Number(localStorage.getItem(REMINDER_KEY) ?? 60);
    return Number.isFinite(v) ? v : 60;
  } catch {
    return 60;
  }
}

const usd = (c: number | null) => (c === null ? 'No limit' : money(c / 100));
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function LimitRow({ l, onSaved }: { l: RgLimit; onSaved: (msg: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(l.current_cents === null ? '' : String(l.current_cents / 100));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pct = l.current_cents ? Math.min(100, (l.used_cents / l.current_cents) * 100) : 0;

  const save = async (amount: number | null) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await setLimit(l.kind, l.period, amount);
      setEditing(false);
      onSaved(r.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rg-limit">
      <div className="rg-limit-top">
        <span className="rg-period">{PERIOD_TITLE[l.period]}</span>
        <strong>{usd(l.current_cents)}</strong>
        {!editing && (
          <button type="button" className="text-btn" onClick={() => setEditing(true)}>
            {l.current_cents === null ? 'Set' : 'Change'}
          </button>
        )}
      </div>
      {l.current_cents !== null && (
        <div className="rg-bar" aria-label={`${money(l.used_cents / 100)} used of ${usd(l.current_cents)}`}>
          <i style={{ width: `${pct}%` }} className={pct >= 100 ? 'full' : ''} />
        </div>
      )}
      <span className="muted small">
        {l.current_cents !== null ? `${money(l.used_cents / 100)} used in the last ${l.window}` : `${money(l.used_cents / 100)} in the last ${l.window}`}
      </span>
      {l.pending && (
        <span className="rg-pending">
          Changes to {usd(l.pending.amount_cents)} on {when(l.pending.effective_at)}
        </span>
      )}
      {editing && (
        <form
          className="rg-edit"
          onSubmit={(e) => {
            e.preventDefault();
            save(Math.round(Number(value) * 100));
          }}
        >
          <label className="field">
            <span>New limit ($)</span>
            <input type="number" min={1} step="1" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
          </label>
          <div className="rg-edit-actions">
            <button type="submit" className="pill-btn sm" disabled={busy || !(Number(value) >= 1)}>
              Save
            </button>
            {l.current_cents !== null && (
              <button type="button" className="ghost-sm" disabled={busy} onClick={() => save(null)}>
                Remove limit
              </button>
            )}
            <button type="button" className="text-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {err && <p className="ticket-error">{err}</p>}
        </form>
      )}
    </li>
  );
}

export function ResponsibleGaming() {
  const { realMoney, session, notify, refreshAccount } = useStore();
  const [rg, setRg] = useState<RgState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reminder, setReminder] = useState(reminderMinutes());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRg(await getRg());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (realMoney && session) load();
  }, [realMoney, session, load]);

  const takeBreak = async (kind: 'cool_off' | 'self_exclusion', days: number | null, label: string) => {
    const ok = await askConfirm(
      kind === 'cool_off'
        ? {
            title: `Take a ${label} break?`,
            message: 'Deposits and new entries stop immediately and can’t be turned back on early. You can still withdraw.',
            confirmLabel: 'Start break',
            destructive: true,
          }
        : {
            title: `Self-exclude ${days === null ? 'permanently' : `for ${label}`}?`,
            message: 'Deposits and new entries stop immediately. This can’t be undone or shortened, even by support. You can still withdraw your balance.',
            confirmLabel: 'Self-exclude',
            destructive: true,
          },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await exclude(kind, days);
      notify(kind === 'cool_off' ? `Break started for ${label}.` : 'Self-exclusion started.');
      await Promise.all([load(), refreshAccount()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const help = (
    <section className="group">
      <h2 className="group-title">Get help</h2>
      <div className="row-card">
        <Icon name="phone" size={18} />
        <div>
          <strong>Call or text 1-800-GAMBLER</strong>
          <p>Free, confidential help around the clock from the National Council on Problem Gambling. Visit ncpgambling.org for chat and local support.</p>
        </div>
        <a className="pill-btn" href="tel:18004262537">
          Call
        </a>
      </div>
    </section>
  );

  if (!realMoney || !session)
    return (
      <div className="page narrow">
        <header className="page-head">
          <h1>Responsible gaming</h1>
        </header>
        <p className="muted">
          {realMoney ? (
            <>
              <Link to="/login?next=/responsible-gaming">Sign in</Link> to set limits, take a break or self-exclude.
            </>
          ) : (
            'Limits and breaks are available on real-money accounts.'
          )}
        </p>
        {help}
      </div>
    );

  const ex = rg?.exclusion;

  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>Responsible gaming</h1>
        <p className="muted">Set limits, see what you’ve spent, or take a break. Lowering a limit works right away; raising or removing one takes 24 hours.</p>
      </header>
      {err && <p className="ticket-error">{err}</p>}

      {ex && (
        <p className="rg-excluded">
          <Icon name="shield" size={16} />
          {ex.until === 'infinity'
            ? 'You’ve self-excluded permanently. Deposits and new entries are off. You can still withdraw your balance.'
            : `You’re on a ${ex.kind === 'cool_off' ? 'break' : 'self-exclusion'} until ${when(ex.until)}. Deposits and new entries are off until then. You can still withdraw.`}
        </p>
      )}

      {rg && (
        <section className="group">
          <h2 className="group-title">Your spending</h2>
          <div className="rg-summary">
            <table className="sport-table">
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Deposited</th>
                  <th scope="col">Staked</th>
                  <th scope="col">Won back</th>
                  <th scope="col">Net</th>
                </tr>
              </thead>
              <tbody>
                {rg.summary.map((r) => {
                  const net = Number(r.returned_cents) - Number(r.staked_cents);
                  return (
                    <tr key={r.period}>
                      <th scope="row">{SUMMARY_TITLE[r.period]}</th>
                      <td>{money(Number(r.deposits_cents) / 100)}</td>
                      <td>{money(Number(r.staked_cents) / 100)}</td>
                      <td>{money(Number(r.returned_cents) / 100)}</td>
                      <td className={net < 0 ? 'neg' : net > 0 ? 'pos' : ''}>{money(net / 100)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {rg &&
        (['deposit', 'stake', 'loss'] as LimitKind[]).map((kind) => (
          <section className="group" key={kind}>
            <h2 className="group-title">{KIND_TITLE[kind]}</h2>
            <p className="muted small rg-help">{KIND_HELP[kind]}</p>
            <ul className="rg-limits">
              {rg.limits
                .filter((l) => l.kind === kind)
                .map((l) => (
                  <LimitRow
                    key={`${l.kind}-${l.period}`}
                    l={l}
                    onSaved={(m) => {
                      notify(m);
                      load();
                    }}
                  />
                ))}
            </ul>
          </section>
        ))}

      <section className="group">
        <h2 className="group-title">Take a break</h2>
        <p className="muted small rg-help">Pause deposits and entries for a while. Breaks can’t be ended early.</p>
        <div className="rg-buttons">
          {[
            [1, '24-hour'],
            [7, '7-day'],
            [30, '30-day'],
          ].map(([d, label]) => (
            <button key={d} type="button" className="ghost-sm" disabled={busy} onClick={() => takeBreak('cool_off', d as number, label as string)}>
              {label} break
            </button>
          ))}
        </div>
      </section>

      <section className="group">
        <h2 className="group-title">Self-exclude</h2>
        <p className="muted small rg-help">For a longer stop. Self-exclusion can’t be shortened or undone, even by our support team.</p>
        <div className="rg-buttons">
          {[
            [180, '6 months'],
            [365, '1 year'],
            [1825, '5 years'],
            [null, 'Permanently'],
          ].map(([d, label]) => (
            <button key={String(d)} type="button" className="ghost-sm danger-btn" disabled={busy} onClick={() => takeBreak('self_exclusion', d as number | null, label as string)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="group">
        <h2 className="group-title">Session reminders</h2>
        <p className="muted small rg-help">A check-in showing how long you’ve been playing and your result for the session.</p>
        <div className="seg seg-wide" role="radiogroup" aria-label="Reminder interval">
          {[
            [30, 'Every 30 min'],
            [60, 'Every hour'],
            [120, 'Every 2 hours'],
            [0, 'Off'],
          ].map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={reminder === m}
              className={reminder === m ? 'on' : ''}
              onClick={() => {
                try {
                  localStorage.setItem(REMINDER_KEY, String(m));
                } catch {
                  /* ignore */
                }
                setReminder(m as number);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {help}
    </div>
  );
}
