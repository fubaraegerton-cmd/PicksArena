import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { excludedUntil, getRg } from '../lib/supabase';
import { reminderMinutes } from '../pages/ResponsibleGaming';
import { money } from '../lib/format';
import { Icon } from './Icon';

const START_KEY = 'picksarena:session-start';

interface Snapshot {
  at: number;
  staked: number;
  returned: number;
}

async function allTime(): Promise<{ staked: number; returned: number }> {
  const r = await getRg();
  const all = r.summary.find((s) => s.period === 'all');
  return { staked: Number(all?.staked_cents ?? 0), returned: Number(all?.returned_cents ?? 0) };
}

/**
 * Responsible-gaming session reminder ("reality check"): every N minutes of a session, shows how
 * long the player has been on and their net result since the session started. N is set on the
 * Responsible gaming page (default 60, 0 = off).
 */
export function RealityCheck() {
  const { realMoney, session } = useStore();
  const [shown, setShown] = useState<{ minutes: number; net: number; staked: number } | null>(null);

  useEffect(() => {
    if (!realMoney || !session) return;
    let start: Snapshot | null = null;
    try {
      start = JSON.parse(sessionStorage.getItem(START_KEY) ?? 'null');
    } catch {
      start = null;
    }
    if (!start) {
      allTime()
        .then((t) => {
          const snap = { at: Date.now(), ...t };
          try {
            sessionStorage.setItem(START_KEY, JSON.stringify(snap));
          } catch {
            /* ignore */
          }
        })
        .catch(() => undefined);
    }
    let lastShown = Date.now();
    const id = setInterval(async () => {
      const every = reminderMinutes();
      if (!every || document.visibilityState !== 'visible') return;
      if (Date.now() - lastShown < every * 60_000) return;
      lastShown = Date.now();
      try {
        const s: Snapshot = JSON.parse(sessionStorage.getItem(START_KEY) ?? 'null');
        if (!s) return;
        const now = await allTime();
        setShown({
          minutes: Math.round((Date.now() - s.at) / 60_000),
          staked: now.staked - s.staked,
          net: now.returned - s.returned - (now.staked - s.staked),
        });
      } catch {
        /* skip this reminder */
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [realMoney, session]);

  if (!shown) return null;
  const h = Math.floor(shown.minutes / 60);
  const m = shown.minutes % 60;
  return (
    <div className="sheet-root" role="dialog" aria-modal="true" aria-labelledby="rc-title">
      <div className="sheet-scrim" />
      <div className="sheet rc-sheet">
        <div className="sheet-body">
          <h2 id="rc-title" className="rc-title">
            You’ve been playing for {h ? `${h} hour${h > 1 ? 's' : ''}` : ''} {m ? `${m} minute${m > 1 ? 's' : ''}` : ''}
          </h2>
          <p className="muted">
            This session you’ve staked {money(shown.staked / 100)} and your result is{' '}
            <strong className={shown.net < 0 ? 'neg' : shown.net > 0 ? 'pos' : ''}>{money(shown.net / 100)}</strong>.
          </p>
          <div className="rc-actions">
            <button type="button" className="cta" onClick={() => setShown(null)}>
              <span>Keep playing</span>
            </button>
            <Link to="/responsible-gaming" className="ghost-sm" onClick={() => setShown(null)}>
              Set limits or take a break
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Banner shown everywhere while a cool-off or self-exclusion is running. */
export function ExclusionBanner() {
  const { realMoney, profile } = useStore();
  const until = realMoney ? excludedUntil(profile?.self_exclusion_until) : null;
  if (!until) return null;
  return (
    <Link to="/responsible-gaming" className="excl-banner">
      <Icon name="shield" size={15} />
      {until === 'permanent'
        ? 'You’ve self-excluded. Deposits and entries are off; you can still withdraw.'
        : `You’re on a break until ${until.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. Deposits and entries are off; you can still withdraw.`}
    </Link>
  );
}
