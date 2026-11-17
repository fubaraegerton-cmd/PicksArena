import { useStore } from '../store';
import { money } from '../lib/format';
import { haptic, useInstallPrompt, useTheme, type ThemePref } from '../lib/device';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';

export function Account() {
  const { balance, entries, deposit, resetAccount } = useStore();
  const [theme, setTheme] = useTheme();
  const install = useInstallPrompt();
  const open = entries.filter((e) => e.status === 'open');
  const atStake = open.reduce((s, e) => s + e.amount, 0);

  return (
    <div className="page narrow">
      <header className="page-head">
        <p className="eyebrow">Wallet & settings</p>
        <h1>Account</h1>
      </header>

      <section className="wallet-card">
        <span className="eyebrow">Balance</span>
        <strong className="wallet-num">{money(balance)}</strong>
        <span className="wallet-sub">{money(atStake)} in {open.length} open entr{open.length === 1 ? 'y' : 'ies'}</span>
        <div className="wallet-actions">
          {[25, 100, 500].map((n) => (
            <button key={n} type="button" onClick={() => { haptic(10); deposit(n); }}>
              <Icon name="plus" size={14} strokeWidth={3} />${n}
            </button>
          ))}
        </div>
        <p className="wallet-fine">Play-money credits for the demo.</p>
      </section>

      <section className="group">
        <h2 className="group-title">Appearance</h2>
        <div className="seg seg-wide" role="radiogroup" aria-label="Theme">
          {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
              {t === 'light' && <Icon name="sun" size={15} />}
              {t === 'dark' && <Icon name="moon" size={15} />}
              {t === 'system' && <Icon name="phone" size={15} />}
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </section>

      {!install.installed && (
        <section className="group">
          <h2 className="group-title">Install the app</h2>
          <div className="row-card">
            <img src="/icons/icon-192.png" alt="" width={44} height={44} />
            <div>
              <strong>PicksArena on your home screen</strong>
              <p>
                {install.canPrompt
                  ? 'Full-screen, launches instantly and works offline.'
                  : install.isIOS
                    ? 'In Safari, tap Share, then “Add to Home Screen”.'
                    : 'Use your browser menu and choose “Install app” or “Add to Home screen”.'}
              </p>
            </div>
            {install.canPrompt && (
              <button type="button" className="pill-btn" onClick={install.prompt}>
                Install
              </button>
            )}
          </div>
        </section>
      )}

      <section className="group">
        <h2 className="group-title">House</h2>
        <Link to="/admin" className="row-card">
          <Icon name="shield" size={18} />
          <div>
            <strong>Admin dashboard</strong>
            <p>Add games, post special picks and enter results.</p>
          </div>
          <Icon name="arrow" size={18} />
        </Link>
      </section>

      <section className="group">
        <h2 className="group-title">Danger zone</h2>
        <button
          type="button"
          className="row-card danger"
          onClick={() => {
            if (confirm('Reset your balance to $100 and delete all entries?')) resetAccount();
          }}
        >
          <Icon name="trash" size={18} />
          <span>Reset account</span>
        </button>
      </section>
    </div>
  );
}
