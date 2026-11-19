import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { saveProfile, supabase } from '../lib/supabase';
import { Icon } from '../components/Icon';

const STATES: [string, string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'],
  ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'],
  ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];

type Mode = 'signin' | 'signup' | 'reset';

function maxDob(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 18);
  return d.toISOString().slice(0, 10);
}

function ProfileFields({ dob, setDob, state, setState }: { dob: string; setDob: (v: string) => void; state: string; setState: (v: string) => void }) {
  return (
    <>
      <label className="field">
        <span>Date of birth</span>
        <input type="date" value={dob} max={maxDob()} onChange={(e) => setDob(e.target.value)} required autoComplete="bday" />
      </label>
      <label className="field">
        <span>State you live in</span>
        <select value={state} onChange={(e) => setState(e.target.value)} required autoComplete="address-level1">
          <option value="" disabled>
            Choose your state…
          </option>
          {STATES.map(([c, n]) => (
            <option key={c} value={c}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function Login() {
  const { session, profile, accountLoaded, refreshAccount, signOut, realMoney } = useStore();
  const [params] = useSearchParams();
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/board';
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dob, setDob] = useState('');
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Prefill setup from what the player entered at sign-up (kept in their auth metadata).
  useEffect(() => {
    if (!session || profile?.dob) return;
    supabase?.auth.getUser().then(({ data }) => {
      const m = data.user?.user_metadata ?? {};
      if (typeof m.dob === 'string') setDob((d) => d || m.dob);
      if (typeof m.state === 'string') setState((s) => s || m.state);
    });
  }, [session, profile]);

  if (!realMoney)
    return (
      <div className="page narrow">
        <header className="page-head">
          <h1>Sign in</h1>
        </header>
        <p className="muted">Accounts aren’t needed in the demo. Your picks and play credits stay on this device.</p>
      </div>
    );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finishSetup = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      await saveProfile(dob, state);
      await refreshAccount();
      navigate(next);
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (!supabase) return;
      if (mode === 'reset') {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/login` });
        if (error) throw error;
        setInfo('If that email has an account, a reset link is on its way.');
        return;
      }
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message === 'Invalid login credentials' ? 'That email and password don’t match.' : error.message);
        await refreshAccount();
        return;
      }
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { dob, state }, emailRedirectTo: `${location.origin}/login?next=${encodeURIComponent(next)}` },
      });
      if (error) throw error;
      if (data.session) {
        await saveProfile(dob, state);
        await refreshAccount();
        navigate(next);
      } else {
        setInfo(`We sent a confirmation link to ${email}. Open it, then sign in here.`);
        setMode('signin');
      }
    });
  };

  if (!accountLoaded)
    return (
      <div className="page narrow">
        <p className="muted">Loading your account…</p>
      </div>
    );

  // Signed in but sign-up not finished (e.g. after confirming email).
  if (session && !profile?.dob)
    return (
      <div className="page narrow">
        <header className="page-head">
          <h1>Finish setting up</h1>
        </header>
        <form className="adm-card adm-login" onSubmit={finishSetup}>
          <p className="muted">We need your date of birth and state before you can play. You can’t change your date of birth later.</p>
          <ProfileFields dob={dob} setDob={setDob} state={state} setState={setState} />
          {error && <p className="ticket-error">{error}</p>}
          <button type="submit" className="cta" disabled={busy || !dob || !state}>
            <span>{busy ? 'Saving…' : 'Save and continue'}</span>
            <Icon name="arrow" size={18} />
          </button>
          <button type="button" className="text-btn" onClick={signOut}>
            Sign out
          </button>
        </form>
      </div>
    );

  if (session)
    return (
      <div className="page narrow">
        <header className="page-head">
          <h1>You’re signed in</h1>
        </header>
        <div className="adm-card adm-login">
          <p>
            Signed in as <strong>{session.email}</strong>.
          </p>
          <Link to={next} className="cta">
            <span>Continue</span>
            <Icon name="arrow" size={18} />
          </Link>
          <button type="button" className="text-btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    );

  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>{mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Sign in'}</h1>
      </header>
      <form className="adm-card adm-login" onSubmit={submit}>
        {mode !== 'reset' && (
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'on' : ''} onClick={() => setMode('signin')}>
              Sign in
            </button>
            <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>
              Create account
            </button>
          </div>
        )}
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        {mode !== 'reset' && (
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'signup' ? 8 : undefined}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </label>
        )}
        {mode === 'signup' && <ProfileFields dob={dob} setDob={setDob} state={state} setState={setState} />}
        {info && <p className="adm-banner">{info}</p>}
        {error && <p className="ticket-error">{error}</p>}
        <button type="submit" className="cta" disabled={busy}>
          <span>{busy ? 'Working…' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</span>
          <Icon name="arrow" size={18} />
        </button>
        {mode === 'signin' && (
          <button type="button" className="text-btn" onClick={() => setMode('reset')}>
            Forgot your password?
          </button>
        )}
        {mode === 'reset' && (
          <button type="button" className="text-btn" onClick={() => setMode('signin')}>
            Back to sign in
          </button>
        )}
        {mode === 'signup' && <p className="fine left">You must be of legal age and located in an eligible state to play for real money.</p>}
      </form>
    </div>
  );
}
