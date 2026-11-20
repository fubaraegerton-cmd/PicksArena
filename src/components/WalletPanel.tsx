import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { money } from '../lib/format';
import {
  cancelWithdrawal,
  fetchPayments,
  requestWithdrawal,
  startDeposit,
  type PaymentMethodRow,
  type PaymentRow,
} from '../lib/supabase';
import { Icon } from './Icon';

const STATUS_LABEL: Record<string, string> = {
  created: 'Waiting for payment',
  succeeded: 'Added',
  failed: 'Failed',
  reversed: 'Charged back',
  requested: 'Requested',
  approved: 'Sending',
  paid: 'Sent',
  rejected: 'Declined',
  cancelled: 'Cancelled',
};

const PRESETS = [25, 50, 100, 250];

/** Real-money wallet: deposit via the processor's hosted checkout, withdraw back to a used method, history. */
export function WalletPanel() {
  const { wallet, refreshAccount, notify } = useStore();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ payments: PaymentRow[]; methods: PaymentMethodRow[] } | null>(null);
  const [mode, setMode] = useState<'none' | 'deposit' | 'withdraw'>('none');
  const [amount, setAmount] = useState('50');
  const [methodId, setMethodId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());

  const load = useCallback(async () => {
    try {
      setData(await fetchPayments());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Back from the processor: the redirect itself never credits anything — poll until the webhook lands.
  const returned = params.get('deposit');
  useEffect(() => {
    if (!returned) return;
    let n = 0;
    const id = setInterval(async () => {
      n++;
      await Promise.all([load(), refreshAccount()]);
      if (n >= 6) clearInterval(id);
    }, 2000);
    return () => clearInterval(id);
  }, [returned, load, refreshAccount]);

  // New form = new idempotency key; retries of the same submission reuse it.
  useEffect(() => {
    key.current = crypto.randomUUID();
  }, [mode, amount, methodId]);

  const withdrawable = useMemo(() => {
    if (!data) return [];
    const used = new Set(data.payments.filter((p) => p.direction === 'deposit' && p.status === 'succeeded').map((p) => p.methodId));
    return data.methods.filter((m) => m.status === 'active' && used.has(m.id));
  }, [data]);
  useEffect(() => {
    if (!methodId && withdrawable[0]) setMethodId(withdrawable[0].id);
  }, [withdrawable, methodId]);

  const cents = Math.round(Number(amount) * 100);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'deposit') {
        const r = await startDeposit(cents, key.current);
        window.location.href = r.redirectUrl;
        return;
      }
      await requestWithdrawal(cents, methodId, key.current);
      notify('Withdrawal requested. We’ll review it shortly.');
      setMode('none');
      await Promise.all([load(), refreshAccount()]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const latest = data?.payments[0];

  return (
    <section className="group" id="wallet">
      <h2 className="group-title">Wallet</h2>

      {returned && latest?.direction === 'deposit' && (
        <p className={`adm-banner ${latest.status === 'succeeded' ? 'ok' : ''}`}>
          {latest.status === 'succeeded'
            ? `${money(latest.amount)} was added to your balance.`
            : latest.status === 'failed'
              ? `That deposit didn’t go through${latest.failureReason ? ` (${latest.failureReason.replace(/_/g, ' ')})` : ''}. You weren’t charged.`
              : 'Your deposit is processing. Your balance updates as soon as the processor confirms it.'}{' '}
          <button type="button" className="text-btn" onClick={() => setParams({}, { replace: true })}>
            Dismiss
          </button>
        </p>
      )}

      <div className="wallet-buttons">
        <button type="button" className={`pill-btn ${mode === 'deposit' ? 'on' : ''}`} onClick={() => setMode(mode === 'deposit' ? 'none' : 'deposit')}>
          <Icon name="plus" size={14} strokeWidth={3} /> Add funds
        </button>
        <button
          type="button"
          className={`ghost-sm ${mode === 'withdraw' ? 'on' : ''}`}
          onClick={() => {
            setMode(mode === 'withdraw' ? 'none' : 'withdraw');
            setAmount(String(Math.max(10, Math.floor(wallet?.available ?? 0))));
          }}
        >
          Withdraw
        </button>
      </div>

      {mode !== 'none' && (
        <form className="adm-card adm-form wallet-form" onSubmit={submit}>
          {mode === 'deposit' && (
            <div className="chips-row">
              {PRESETS.map((p) => (
                <button key={p} type="button" className={`chip ${Number(amount) === p ? 'on' : ''}`} onClick={() => setAmount(String(p))}>
                  ${p}
                </button>
              ))}
            </div>
          )}
          <label className="field">
            <span>Amount</span>
            <input type="number" inputMode="decimal" min={10} max={mode === 'deposit' ? 2500 : undefined} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
          {mode === 'withdraw' &&
            (withdrawable.length ? (
              <label className="field">
                <span>Send to</span>
                <select value={methodId} onChange={(e) => setMethodId(e.target.value)} required>
                  {withdrawable.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="muted small">Withdrawals go back to a payment method you’ve deposited with. Make a deposit first.</p>
            ))}
          <p className="muted small">
            {mode === 'deposit'
              ? 'You’ll finish paying on our payment partner’s secure page. $10 minimum, $2,500 maximum per deposit.'
              : `Available to withdraw: ${money(wallet?.available ?? 0)}. Withdrawals need a verified identity and are reviewed before they’re sent.`}
          </p>
          {err && <p className="ticket-error">{err}</p>}
          <button type="submit" className="cta" disabled={busy || !(cents >= 1000) || (mode === 'withdraw' && !withdrawable.length)}>
            <span>{busy ? 'Working…' : mode === 'deposit' ? `Continue to payment` : `Request ${Number.isFinite(cents) ? money(cents / 100) : ''} withdrawal`}</span>
            <Icon name="arrow" size={18} />
          </button>
        </form>
      )}

      {data && data.payments.length > 0 && (
        <ul className="pay-history">
          {data.payments.map((p) => (
            <li key={p.id}>
              <span className={`pay-dir ${p.direction}`}>
                <Icon name={p.direction === 'deposit' ? 'down' : 'up'} size={14} strokeWidth={3} />
              </span>
              <div>
                <strong>
                  {p.direction === 'deposit' ? 'Deposit' : 'Withdrawal'} {money(p.amount)}
                </strong>
                <span className="muted small">
                  {new Date(p.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  {p.status === 'rejected' && p.failureReason ? `, ${p.failureReason}` : ''}
                </span>
              </div>
              <span className={`pay-status s-${p.status}`}>
                {/* An abandoned checkout isn't failed here: the processor may still confirm it, and reconciliation would catch that. */}
                {p.status === 'created' && Date.now() - p.createdAt > 30 * 60_000 ? 'Not completed' : STATUS_LABEL[p.status] ?? p.status}
              </span>
              {p.status === 'requested' && (
                <button
                  type="button"
                  className="text-btn"
                  onClick={async () => {
                    try {
                      await cancelWithdrawal(p.id);
                      notify('Withdrawal cancelled. The money is back in your balance.');
                      await Promise.all([load(), refreshAccount()]);
                    } catch (e) {
                      setErr((e as Error).message);
                    }
                  }}
                >
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
