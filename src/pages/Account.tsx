import { useStore } from '../store';
import { askConfirm } from '../components/NativeDialog';
import { money } from '../lib/format';
import { haptic, useInstallPrompt, useTheme, type ThemePref } from '../lib/device';
import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getKyc, startKyc, type KycStatus } from '../lib/supabase';
import { WalletPanel } from '../components/WalletPanel';

const KYC_COPY: Record<KycStatus, string> = {
  none: 'Needed before your first withdrawal. It takes about two minutes: a photo of your ID and a quick selfie.',
  pending: 'Started. Finish the steps with our verification partner to complete it.',
  review: 'Submitted. We’ll update this page as soon as the review is done.',
  approved: 'Verified. You’re cleared for withdrawals.',
  rejected: 'We couldn’t verify your identity. Contact support to sort it out.',
};

function IdentityCard() {
  const [state, setState] = useState<{ available: boolean; status: KycStatus; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getKyc().then(setState).catch((e) => setErr((e as Error).message));
  }, []);
  if (!state) return err ? <p className="ticket-error">{err}</p> : null;
  const canStart = state.available && (state.status === 'none' || state.status === 'pending');
  return (
    <div className="row-card">
      <Icon name={state.status === 'approved' ? 'check' : 'shield'} size={18} />
      <div>
        <strong>Identity check{state.status === 'approved' ? ': verified' : state.status === 'review' ? ': in review' : ''}</strong>
        <p>
          {state.status === 'rejected' && state.reason === 'duplicate_identity'
            ? 'This identity is already verified on another account. Each person can have one account.'
            : !state.available && state.status === 'none'
              ? 'Identity checks open soon. You’ll need one before your first withdrawal.'
              : KYC_COPY[state.status]}
        </p>
        {err && <p className="neg">{err}</p>}
      </div>
      {canStart && (
        <button
          type="button"
          className="pill-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await startKyc();
              if (r.url) window.location.href = r.url;
              else setState((s) => s && { ...s, status: r.status });
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {state.status === 'pending' ? 'Continue' : 'Verify'}
        </button>
      )}
    </div>
  );
}
import { Icon } from '../components/Icon';

export function Account() {
  const { balance, entries, deposit, resetAccount, realMoney, session, profile, wallet, signOut } = useStore();
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

      {realMoney && !session && (
        <section className="group">
          <Link to="/login?next=/account" className="row-card">
            <Icon name="user" size={18} />
            <div>
              <strong>Sign in to see your wallet</strong>
              <p>Or create an account to play for real money.</p>
            </div>
            <Icon name="arrow" size={18} />
          </Link>
        </section>
      )}

      {realMoney && session && (
      <section className="wallet-card">
        <span className="eyebrow">Available</span>
        <strong className="wallet-num">{money(wallet?.available ?? 0)}</strong>
        <span className="wallet-sub">
          {money(wallet?.inPlay ?? 0)} in {open.length} open entr{open.length === 1 ? 'y' : 'ies'}
          {wallet?.held ? `, ${money(wallet.held)} held for withdrawal` : ''}
        </span>
        <p className="wallet-fine">Every movement of your money is recorded on your account’s ledger.</p>
      </section>
      )}

      {realMoney && session && <WalletPanel />}

      {!realMoney && (
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
      )}

      {realMoney && session && (
        <section className="group">
          <h2 className="group-title">Your account</h2>
          <div className="row-card">
            <Icon name="user" size={18} />
            <div>
              <strong>{session.email}</strong>
              <p>
                {profile?.state ? `Home state: ${profile.state}.` : ''}
              </p>
            </div>
            <button type="button" className="pill-btn" onClick={signOut}>
              Sign out
            </button>
          </div>
          <div style={{ marginTop: 8 }}>
            <IdentityCard />
          </div>
        </section>
      )}

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

      {realMoney && (
        <section className="group">
          <h2 className="group-title">Play responsibly</h2>
          <Link to="/responsible-gaming" className="row-card">
            <Icon name="shield" size={18} />
            <div>
              <strong>Limits, breaks and self-exclusion</strong>
              <p>Set deposit, stake and loss limits, see your spending, or take a break.</p>
            </div>
            <Icon name="arrow" size={18} />
          </Link>
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

      {!realMoney && (
      <section className="group">
        <h2 className="group-title">Danger zone</h2>
        <button
          type="button"
          className="row-card danger"
          onClick={() => {
            askConfirm({ title: 'Reset your account?', message: 'Your balance goes back to $100 and all entries are deleted.', confirmLabel: 'Reset', destructive: true }).then((ok) => ok && resetAccount());
          }}
        >
          <Icon name="trash" size={18} />
          <span>Reset account</span>
        </button>
      </section>
      )}
    </div>
  );
}
