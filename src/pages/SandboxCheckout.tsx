import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { completeSandboxCheckout } from '../lib/supabase';
import { money } from '../lib/format';

/**
 * Stand-in for a payment processor's hosted checkout page. In production the player is
 * sent to the real processor instead; nothing on this page credits a balance — it asks the
 * sandbox processor to send a signed webhook, exactly as a real processor would.
 */
export function SandboxCheckout() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const ref = params.get('ref') ?? '';
  const amount = Number(params.get('amount') ?? 0) / 100;
  const [last4, setLast4] = useState('4242');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const finish = async (outcome: 'approve' | 'decline') => {
    setBusy(true);
    setErr(null);
    try {
      await completeSandboxCheckout(ref, outcome, last4);
      navigate('/account?deposit=returned#wallet');
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <div className="adm-card adm-login sandbox-checkout">
        <p className="sandbox-badge">Sandbox processor: test payments only, no real money</p>
        <h1 className="sandbox-amount">{money(amount)}</h1>
        <p className="muted">Deposit to PicksArena</p>
        <label className="field">
          <span>Test card, last 4 digits</span>
          <input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" />
        </label>
        {err && <p className="ticket-error">{err}</p>}
        <button type="button" className="cta" disabled={busy || last4.length !== 4} onClick={() => finish('approve')}>
          <span>{busy ? 'Processing…' : `Pay ${money(amount)}`}</span>
        </button>
        <button type="button" className="text-btn" disabled={busy} onClick={() => finish('decline')}>
          Simulate a declined card
        </button>
      </div>
    </div>
  );
}
