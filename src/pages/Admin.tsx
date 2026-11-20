import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { SPORTS, sportById } from '../data/sports';
import type { AdminAction, AdminData, AdminGame, AdminPick, AdminSport, AdminTeam } from '../shared/admin';
import { EMPTY_DATA, lineError } from '../shared/admin';
import { AdminError, adminAudit, adminCompliance, adminCompliancePost, adminDo, adminLogin, adminPayments, adminPaymentsPost, rememberPassword, savedPassword, type AuditRow, type ComplianceData, type PaymentsData } from '../lib/adminApi';
import { REAL_MONEY, supabase } from '../lib/supabase';
import { OperatorsCard, PlayersTab } from './admin/Players';

/** In real-money mode the dashboard authenticates with the signed-in operator's session, checked server-side. */
async function operatorToken(): Promise<string | null> {
  if (!supabase) return null;
  return (await supabase.auth.getSession()).data.session?.access_token ?? null;
}

const DENY_LABEL: Record<string, string> = {
  location_unknown: 'Location unknown',
  outside_us: 'Outside the US',
  state_not_eligible: 'State not enabled',
  vpn_or_proxy: 'VPN or proxy',
  vpn_check_unavailable: 'VPN check failed',
};

function ComplianceTab({ notify }: { notify: (m: string) => void }) {
  const [c, setC] = useState<ComplianceData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'enabled' | 'all'>('all');

  const load = useCallback(async () => {
    try {
      setC(await adminCompliance((await operatorToken()) ?? ''));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (body: Record<string, unknown>, done = 'Saved') => {
    setBusy(true);
    setErr(null);
    try {
      const r = await adminCompliancePost((await operatorToken()) ?? '', body);
      setC(r.compliance);
      notify(done);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!c) return <p className="muted">{err ?? 'Loading compliance…'}</p>;
  const enabled = c.jurisdictions.filter((j) => j.enabled);
  const states = filter === 'enabled' ? enabled : c.jurisdictions;

  return (
    <div className="adm-stack">
      {err && <p className="ticket-error">{err}</p>}
      <div className="adm-cols">
        <section className="adm-card">
          <header className="adm-card-head">
            <h2>Identity checks</h2>
            <span className="muted">{c.kycQueue.length} waiting</span>
          </header>
          {c.kycQueue.length === 0 ? (
            <p className="adm-empty">No identity checks waiting for review.</p>
          ) : (
            <ul className="adm-rows">
              {c.kycQueue.map((k) => (
                <li key={k.id} className="adm-row">
                  <div className="adm-row-main">
                    <strong>{k.email}</strong>
                    <span className="muted small">
                      {k.provider}, {k.status === 'review' ? 'needs review' : 'in progress'}, started {new Date(k.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="adm-row-actions">
                    <button type="button" className="pill-btn sm" disabled={busy} onClick={() => act({ action: 'kycDecision', recordId: k.id, status: 'approved' }, 'Identity approved')}>
                      Approve
                    </button>
                    <button
                      type="button"
                      className="ghost-sm"
                      disabled={busy}
                      onClick={() => {
                        const reason = prompt('Reason for rejecting (shown in the audit trail):');
                        if (reason) act({ action: 'kycDecision', recordId: k.id, status: 'rejected', reason }, 'Identity rejected');
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="adm-card">
          <header className="adm-card-head">
            <h2>Flagged accounts</h2>
            <span className="muted">{c.flagged.length}</span>
          </header>
          {c.flagged.length === 0 ? (
            <p className="adm-empty">No flagged accounts.</p>
          ) : (
            <ul className="adm-rows">
              {c.flagged.map((f) => {
                const blocked = f.flags.blocked === true;
                const why = Object.keys(f.flags).filter((k) => ['shared_device', 'duplicate_identity'].includes(k) && f.flags[k] === true);
                return (
                  <li key={f.id} className="adm-row">
                    <div className="adm-row-main">
                      <strong>{f.email}</strong>
                      <span className="muted small">
                        {why.map((w) => (w === 'shared_device' ? 'Shares a device with another account' : 'Identity already verified elsewhere')).join('; ') || 'Manual flag'}
                        {blocked ? '. On hold.' : ''}
                      </span>
                    </div>
                    <div className="adm-row-actions">
                      <button type="button" className={blocked ? 'ghost-sm' : 'pill-btn sm'} disabled={busy} onClick={() => act({ action: 'setBlocked', userId: f.id, blocked: !blocked }, blocked ? 'Hold removed' : 'Account on hold')}>
                        {blocked ? 'Remove hold' : 'Put on hold'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="adm-card">
        <header className="adm-card-head wrap">
          <h2>Eligible states</h2>
          <div className="adm-filters">
            <span className="muted small">{enabled.length ? `${enabled.length} enabled: ${enabled.map((j) => j.state).join(', ')}` : 'None enabled. Nobody can play yet.'}</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as 'enabled' | 'all')} aria-label="Show states">
              <option value="all">All states</option>
              <option value="enabled">Enabled only</option>
            </select>
          </div>
        </header>
        <p className="muted small">Switch a state on only where you hold a licence. Players located elsewhere can’t place entries, and the minimum age applied is the stricter of where they live and where they are.</p>
        <ul className="jur-grid">
          {states.map((j) => (
            <li key={j.state} className={j.enabled ? 'on' : ''}>
              <label className="switch">
                <input type="checkbox" checked={j.enabled} disabled={busy} onChange={(e) => act({ action: 'setJurisdiction', state: j.state, enabled: e.target.checked, minAge: j.min_age }, `${j.name} ${e.target.checked ? 'enabled' : 'disabled'}`)} />
                <span className="switch-ui" aria-hidden />
                <span>
                  <strong>{j.name}</strong>
                </span>
              </label>
              <select value={j.min_age} disabled={busy} aria-label={`${j.name} minimum age`} onChange={(e) => act({ action: 'setJurisdiction', state: j.state, enabled: j.enabled, minAge: Number(e.target.value) }, `${j.name} minimum age ${e.target.value}`)}>
                {[18, 19, 21].map((a) => (
                  <option key={a} value={a}>
                    {a}+
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </section>

      <OperatorsCard notify={notify} />

      <section className="adm-card">
        <header className="adm-card-head">
          <h2>Recent location blocks</h2>
          <button type="button" className="text-btn" onClick={load}>
            Refresh
          </button>
        </header>
        {c.geoDenials.length === 0 ? (
          <p className="adm-empty">No blocked attempts yet.</p>
        ) : (
          <table className="sport-table geo-table">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">Action</th>
                <th scope="col">Where</th>
                <th scope="col">Why</th>
                <th scope="col" className="hide-sm">When</th>
              </tr>
            </thead>
            <tbody>
              {c.geoDenials.map((g) => (
                <tr key={g.id}>
                  <td>{g.email}</td>
                  <td>{g.action}</td>
                  <td>{[g.region, g.country].filter(Boolean).join(', ') || 'Unknown'}</td>
                  <td>{DENY_LABEL[g.reason ?? ''] ?? g.reason}</td>
                  <td className="hide-sm">{new Date(g.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const usd = (c: number | null | undefined) => (c == null ? '—' : `$${(Number(c) / 100).toFixed(2)}`);

/** Standard reason codes so declines are consistent and reportable. */
const DECLINE_REASONS = [
  ['name_mismatch', 'Name on the payment method doesn’t match the verified identity'],
  ['identity_unverified', 'Identity check incomplete or failed'],
  ['suspected_fraud', 'Suspected fraud or account takeover'],
  ['duplicate_account', 'Linked to another account'],
  ['responsible_gaming', 'Responsible gaming review'],
  ['processor_issue', 'Payment method can’t receive payouts'],
  ['other', 'Other (explain in the note)'],
] as const;
const FAIL_REASONS = [
  ['processor_failed', 'Processor reports the payment failed'],
  ['abandoned', 'Checkout abandoned (processor confirms no charge)'],
  ['other', 'Other (explain in the note)'],
] as const;

function ReasonPicker({ reasons, onPick, label, busy }: { reasons: readonly (readonly [string, string])[]; onPick: (reason: string) => void; label: string; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string>(reasons[0][0]);
  const [note, setNote] = useState('');
  if (!open)
    return (
      <button type="button" className="ghost-sm" disabled={busy} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <form
      className="reason-picker"
      onSubmit={(e) => {
        e.preventDefault();
        const text = reasons.find(([c]) => c === code)![1];
        onPick(`${code}: ${text}${note.trim() ? `. ${note.trim()}` : ''}`);
        setOpen(false);
      }}
    >
      <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="Reason">
        {reasons.map(([c, t]) => (
          <option key={c} value={c}>
            {t}
          </option>
        ))}
      </select>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (shown to the player for declines)" maxLength={200} required={code === 'other'} aria-label="Note" />
      <button type="submit" className="pill-btn sm" disabled={busy}>
        {label}
      </button>
      <button type="button" className="text-btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
const ISSUE_LABEL: Record<string, string> = {
  missing_internally: 'Settled by the processor but not completed here',
  amount_mismatch: 'Amounts disagree',
  missing_at_provider: 'Completed here but missing from the processor report',
  ledger_missing: 'Completed payment with no ledger transaction',
};

function PaymentsTab({ notify }: { notify: (m: string) => void }) {
  const [d, setD] = useState<PaymentsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [csv, setCsv] = useState('');

  const load = useCallback(async () => {
    try {
      setD(await adminPayments((await operatorToken()) ?? ''));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await adminPaymentsPost((await operatorToken()) ?? '', body);
      setD(r.payments);
      notify(r.note);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!d) return <p className="muted">{err ?? 'Loading payments…'}</p>;

  return (
    <div className="adm-stack">
      {!d.provider && <p className="adm-banner">No payment processor is connected, so deposits and withdrawals are closed. Set PAYMENTS_PROVIDER in Vercel.</p>}
      {d.sandbox && <p className="adm-banner">Sandbox processor: test payments only. No real money moves. Turn this off before launch.</p>}
      {err && <p className="ticket-error">{err}</p>}

      <section className="adm-card">
        <header className="adm-card-head">
          <h2>Withdrawals to review</h2>
          <span className="muted">{d.withdrawalQueue.length} waiting</span>
        </header>
        {d.withdrawalQueue.length === 0 ? (
          <p className="adm-empty">Nothing waiting.</p>
        ) : (
          <ul className="adm-rows">
            {d.withdrawalQueue.map((w) => {
              const flags = Object.keys(w.profile?.flags ?? {}).filter((k) => w.profile?.flags[k] === true);
              return (
                <li key={w.id} className="adm-row">
                  <div className="adm-row-main">
                    <span className="pick-title">
                      <strong>{usd(w.amount_cents)}</strong>
                      <span>{w.email}</span>
                    </span>
                    <span className="wd-context">
                      <span>To <b>{w.payment_methods?.label ?? 'unknown method'}</b></span>
                      <span>ID check <b>{w.profile?.kyc_status ?? 'none'}</b></span>
                      <span>State <b>{w.profile?.state ?? '—'}</b></span>
                      <span>Available <b>{usd(w.wallet?.available_cents)}</b></span>
                      <span>Deposited <b>{usd(w.deposited_cents)}</b></span>
                      <span>Withdrawn <b>{usd(w.withdrawn_cents)}</b></span>
                      {flags.length > 0 && <span className="neg">Flags: {flags.join(', ')}</span>}
                    </span>
                    <span className="muted small">Requested {new Date(w.created_at).toLocaleString()}</span>
                  </div>
                  <div className="adm-row-actions">
                    <button type="button" className="pill-btn sm" disabled={busy} onClick={() => act({ action: 'reviewWithdrawal', paymentId: w.id, approve: true })}>
                      Approve and pay
                    </button>
                    <ReasonPicker reasons={DECLINE_REASONS} label="Decline" busy={busy} onPick={(reason) => act({ action: 'reviewWithdrawal', paymentId: w.id, approve: false, reason })} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {(d.pendingDeposits?.length ?? 0) > 0 && (
        <section className="adm-card">
          <header className="adm-card-head">
            <h2>Pending deposits</h2>
            <span className="muted">{d.pendingDeposits.length}</span>
          </header>
          <p className="muted small">Checkouts that haven’t been confirmed. Only mark one failed once the processor confirms no money was taken; a later success would then be refused and show up in reconciliation.</p>
          <ul className="adm-rows">
            {d.pendingDeposits.map((p) => (
              <li key={p.id} className="adm-row">
                <div className="adm-row-main">
                  <strong>
                    {usd(p.amount_cents)} from {p.email}
                  </strong>
                  <span className="muted small">
                    Started {new Date(p.created_at).toLocaleString()}, {p.provider} ref {p.provider_ref ?? 'none'}
                  </span>
                </div>
                <div className="adm-row-actions">
                  <ReasonPicker reasons={FAIL_REASONS} label="Mark failed" busy={busy} onPick={(reason) => act({ action: 'failDeposit', paymentId: p.id, reason })} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="adm-card">
        <header className="adm-card-head wrap">
          <h2>Reconciliation</h2>
          {d.reconciliation.length === 0 ? <span className="recon-ok">Everything matches</span> : <span className="neg">{d.reconciliation.length} to look at</span>}
        </header>
        {d.reconciliation.length > 0 && (
          <table className="sport-table geo-table">
            <thead>
              <tr>
                <th scope="col">Issue</th>
                <th scope="col">Processor ref</th>
                <th scope="col">Ours</th>
                <th scope="col">Theirs</th>
              </tr>
            </thead>
            <tbody>
              {d.reconciliation.map((r, i) => (
                <tr key={i}>
                  <td>{ISSUE_LABEL[r.issue] ?? r.issue}</td>
                  <td>{r.provider_ref}</td>
                  <td>{usd(r.ours_cents)}</td>
                  <td>{usd(r.theirs_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Import the processor’s settlement report to compare it with your payments and the ledger. Paste CSV as <code>ref,deposit|withdrawal,amount_cents</code>, or pull it straight from the processor if it supports that.</p>
        <textarea className="recon-csv" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="sbx_dep_…,deposit,5000" aria-label="Settlement report CSV" />
        <div className="adm-row-actions">
          <button type="button" className="pill-btn sm" disabled={busy || !csv.trim()} onClick={async () => (await act({ action: 'importSettlements', csv })) && setCsv('')}>
            Import CSV
          </button>
          {d.provider && (
            <button type="button" className="ghost-sm" disabled={busy} onClick={() => act({ action: 'importSettlements' })}>
              Pull report from {d.provider}
            </button>
          )}
        </div>
      </section>

      <section className="adm-card">
        <header className="adm-card-head">
          <h2>Recent payments</h2>
          <button type="button" className="text-btn" onClick={load}>
            Refresh
          </button>
        </header>
        {d.recent.length === 0 ? (
          <p className="adm-empty">No payments yet.</p>
        ) : (
          <ul className="adm-rows">
            {d.recent.map((p) => (
              <li key={p.id} className="adm-row">
                <div className="adm-row-main">
                  <span className="pick-title">
                    <strong>
                      {p.direction === 'deposit' ? 'Deposit' : 'Withdrawal'} {usd(p.amount_cents)}
                    </strong>
                    <span className={`pay-status s-${p.status}`}>{p.status}</span>
                  </span>
                  <span className="muted small">
                    {p.email}, {new Date(p.created_at).toLocaleString()}
                    {p.reviewed_by ? `, reviewed by ${p.reviewed_by}` : ''}
                    {p.failure_reason ? `. ${p.failure_reason}` : ''}
                  </span>
                </div>
                {d.sandbox && p.direction === 'deposit' && p.status === 'succeeded' && (
                  <div className="adm-row-actions">
                    <button
                      type="button"
                      className="ghost-sm"
                      disabled={busy}
                      onClick={() => confirm('Simulate a chargeback? The player’s account is frozen and unspent cash is clawed back.') && act({ action: 'simulateChargeback', paymentId: p.id })}
                    >
                      Simulate chargeback
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AuditTab() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [action, setAction] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async (a = '', e = '') => {
    try {
      setErr(null);
      setRows((await adminAudit((await operatorToken()) ?? '', a, e)).rows);
    } catch (x) {
      setErr((x as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <section className="adm-card">
      <header className="adm-card-head wrap">
        <h2>Audit log</h2>
        <form
          className="adm-filters"
          onSubmit={(e) => {
            e.preventDefault();
            load(action, email);
          }}
        >
          <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by type">
            <option value="">Everything</option>
            <option value="ledger.">Money movements</option>
            <option value="payment.">Payments</option>
            <option value="kyc.">Identity checks</option>
            <option value="limit.">Limits</option>
            <option value="exclusion.">Breaks and exclusions</option>
            <option value="profile.">Account changes</option>
            <option value="operator.">Operator actions</option>
            <option value="geo.">Location blocks</option>
            <option value="line.">Lines and results</option>
            <option value="jurisdiction.">State settings</option>
          </select>
          <input type="email" placeholder="Player email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Player email" className="audit-email" />
          <button type="submit" className="pill-btn sm">
            Filter
          </button>
        </form>
      </header>
      <p className="muted small">Append-only: entries can’t be edited or deleted, by anyone.</p>
      {err && <p className="ticket-error">{err}</p>}
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="adm-empty">No entries match.</p>
      ) : (
        <ul className="audit-rows">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="audit-when">{new Date(r.at).toLocaleString()}</span>
              <strong>{r.action}</strong>
              <span className="muted small">
                by {r.actor}
                {r.subject ? `, player ${r.subject}` : ''}
              </span>
              <code className="audit-details">{JSON.stringify(r.details)}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CreditFunds({ run }: { run: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [email, setEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  return (
    <form
      className="adm-card adm-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run({ action: 'creditFunds', email, amountCents: Math.round(Number(amount) * 100), reason });
        if (ok) {
          setAmount('');
          setReason('');
        }
      }}
    >
      <header className="adm-card-head">
        <h2>Adjust a balance</h2>
        <span className="muted">Recorded on the ledger</span>
      </header>
      <p className="muted small">For test funds until deposits open, and for corrections. Use a negative amount to debit.</p>
      <div className="field-row">
        <label className="field grow">
          <span>Player email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field w-md">
          <span>Amount $</span>
          <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required inputMode="decimal" />
        </label>
      </div>
      <label className="field">
        <span>Reason</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={140} placeholder="e.g. Test funds for QA" />
      </label>
      <button type="submit" className="cta">
        <span>Apply adjustment</span>
      </button>
    </form>
  );
}
import { gameTime } from '../lib/format';
import { Icon } from '../components/Icon';

type Tab = 'overview' | 'players' | 'games' | 'picks' | 'payments' | 'compliance' | 'audit';
type Phase = 'live' | 'upcoming' | 'final' | 'cancelled';

const phaseOf = (g: AdminGame, now: number): Phase =>
  g.status === 'final' ? 'final' : g.status === 'cancelled' ? 'cancelled' : g.startsAt <= now ? 'live' : 'upcoming';

const PHASE_LABEL: Record<Phase, string> = { live: 'In progress', upcoming: 'Upcoming', final: 'Final', cancelled: 'Cancelled' };

/* ------------------------------------------------------------------ */
/* Login                                                              */
/* ------------------------------------------------------------------ */

function Login({ onDone }: { onDone: (pass: string, data: AdminData, storage: string) => void }) {
  const [pass, setPass] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await adminLogin(pass);
      rememberPassword(pass);
      onDone(pass, r.data, r.storage);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <header className="page-head">
        <p className="eyebrow">Restricted</p>
        <h1>Admin</h1>
      </header>
      <form className="adm-card adm-login" onSubmit={submit}>
        <div className="adm-login-ico">
          <Icon name="shield" size={22} />
        </div>
        <label className="field">
          <span>Admin password</span>
          <div className="pw">
            <input
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              required
              autoFocus
            />
            <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
              <Icon name={show ? 'eyeOff' : 'eye'} size={18} />
            </button>
          </div>
        </label>
        {err && <p className="ticket-error">{err}</p>}
        <button type="submit" className="cta" disabled={busy || !pass}>
          <span>{busy ? 'Checking…' : 'Sign in'}</span>
          <Icon name="arrow" size={18} />
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                           */
/* ------------------------------------------------------------------ */

function Overview({ data, now, go }: { data: AdminData; now: number; go: (tab: Tab, gameId?: string) => void }) {
  const { board } = useStore();
  const byPhase = useMemo(() => {
    const m: Record<Phase, AdminGame[]> = { live: [], upcoming: [], final: [], cancelled: [] };
    data.games.forEach((g) => m[phaseOf(g, now)].push(g));
    m.upcoming.sort((a, b) => a.startsAt - b.startsAt);
    return m;
  }, [data.games, now]);

  const picksBy = useMemo(() => {
    const m = new Map<string, AdminPick[]>();
    data.picks.forEach((p) => m.set(p.gameId, [...(m.get(p.gameId) ?? []), p]));
    return m;
  }, [data.picks]);

  const needsResults = useMemo(
    () =>
      data.games
        .filter((g) => g.status !== 'cancelled' && g.startsAt <= now)
        .map((g) => ({ g, missing: (picksBy.get(g.id) ?? []).filter((p) => p.active && p.actual === undefined).length }))
        .filter((x) => x.missing > 0)
        .sort((a, b) => a.g.startsAt - b.g.startsAt),
    [data.games, picksBy, now],
  );

  const liveSpecials = data.picks.filter((p) => {
    const g = data.games.find((x) => x.id === p.gameId);
    return p.special && p.active && g && g.status === 'scheduled' && g.startsAt > now;
  }).length;
  const onBoard = data.picks.filter((p) => {
    const g = data.games.find((x) => x.id === p.gameId);
    return p.active && g && g.status === 'scheduled' && g.startsAt > now;
  }).length;

  const generatedBySport = useMemo(() => {
    const m = new Map<string, number>();
    board.filter((p) => p.source !== 'admin').forEach((p) => m.set(p.player.sport, (m.get(p.player.sport) ?? 0) + 1));
    return m;
  }, [board]);

  return (
    <div className="adm-stack">
      <div className="adm-kpis">
        <button type="button" className="adm-kpi" onClick={() => go('games')}>
          <span className="eyebrow">Upcoming games</span>
          <strong>{byPhase.upcoming.length}</strong>
          <span className="sub">{byPhase.live.length} in progress</span>
        </button>
        <button type="button" className="adm-kpi" onClick={() => go('picks')}>
          <span className="eyebrow">Picks on the board</span>
          <strong>{onBoard}</strong>
          <span className="sub">{data.picks.length} created in total</span>
        </button>
        <button type="button" className="adm-kpi accent" onClick={() => go('picks')}>
          <span className="eyebrow">Live specials</span>
          <strong>{liveSpecials}</strong>
          <span className="sub">Featured in the Specials tab</span>
        </button>
        <button type="button" className={`adm-kpi ${needsResults.length ? 'warn' : ''}`} onClick={() => go('picks')}>
          <span className="eyebrow">Awaiting results</span>
          <strong>{needsResults.reduce((s, x) => s + x.missing, 0)}</strong>
          <span className="sub">{needsResults.length} game{needsResults.length === 1 ? '' : 's'} need final stats</span>
        </button>
      </div>

      <div className="adm-cols">
        <section className="adm-card">
          <header className="adm-card-head">
            <h2>Needs results</h2>
            <span className="muted">Settles players’ entries</span>
          </header>
          {needsResults.length === 0 ? (
            <p className="adm-empty">Nothing waiting. Results are up to date.</p>
          ) : (
            <ul className="adm-list">
              {needsResults.map(({ g, missing }) => (
                <li key={g.id}>
                  <Matchup g={g} />
                  <span className="muted small">{gameTime(g.startsAt, now)}</span>
                  <button type="button" className="pill-btn sm" onClick={() => go('picks', g.id)}>
                    Enter {missing} result{missing === 1 ? '' : 's'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="adm-card">
          <header className="adm-card-head">
            <h2>Up next</h2>
            <button type="button" className="text-btn" onClick={() => go('games')}>
              <Icon name="plus" size={14} strokeWidth={3} /> Add game
            </button>
          </header>
          {byPhase.upcoming.length === 0 ? (
            <p className="adm-empty">No upcoming games. Add one to start posting picks.</p>
          ) : (
            <ul className="adm-list">
              {byPhase.upcoming.slice(0, 6).map((g) => {
                const ps = picksBy.get(g.id) ?? [];
                return (
                  <li key={g.id}>
                    <Matchup g={g} />
                    <span className="muted small">{gameTime(g.startsAt, now)}</span>
                    <button type="button" className="adm-count" onClick={() => go('picks', g.id)}>
                      {ps.length} pick{ps.length === 1 ? '' : 's'}
                      {ps.some((p) => p.special) && <Icon name="star" size={12} strokeWidth={2.5} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="adm-card">
        <header className="adm-card-head">
          <h2>Games by sport</h2>
          <span className="muted">Your games · auto-generated lines</span>
        </header>
        <div className="adm-sports">
          {SPORTS.map((s) => {
            const mine = data.games.filter((g) => g.sport === s.id);
            const up = mine.filter((g) => phaseOf(g, now) === 'upcoming').length;
            return (
              <div key={s.id} className="adm-sport">
                <strong>{s.label}</strong>
                <span>
                  <b>{mine.length}</b> games{up ? ` · ${up} upcoming` : ''}
                </span>
                <span className="muted">{generatedBySport.get(s.id) ?? 0} generated lines</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Matchup({ g }: { g: AdminGame }) {
  return (
    <span className="adm-matchup">
      <span className="adm-sport-tag">{sportById(g.sport as never)?.label ?? g.sport}</span>
      <i style={{ background: g.away.color }} />
      {g.away.abbr}
      <span className="at">@</span>
      <i style={{ background: g.home.color }} />
      {g.home.abbr}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Games                                                              */
/* ------------------------------------------------------------------ */

function toLocalInput(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TeamPicker({ sport, value, onChange, label }: { sport: AdminSport; value: AdminTeam; onChange: (t: AdminTeam) => void; label: string }) {
  const presets = sportById(sport as never)?.teams ?? [];
  const preset = presets.find((t) => t.abbr === value.abbr && t.name === value.name);
  const [custom, setCustom] = useState(!preset && !!value.abbr);
  return (
    <fieldset className="team-picker">
      <legend>{label}</legend>
      <select
        value={custom ? '__custom' : preset?.abbr ?? ''}
        onChange={(e) => {
          if (e.target.value === '__custom') {
            setCustom(true);
            onChange({ abbr: '', name: '', color: '#3a7bd5' });
          } else {
            setCustom(false);
            const t = presets.find((x) => x.abbr === e.target.value);
            if (t) onChange({ ...t });
          }
        }}
        required
      >
        <option value="" disabled>
          Choose team…
        </option>
        {presets.map((t) => (
          <option key={t.abbr} value={t.abbr}>
            {t.abbr} · {t.name}
          </option>
        ))}
        <option value="__custom">Custom team…</option>
      </select>
      {custom && (
        <div className="team-custom">
          <input
            placeholder="ABC"
            value={value.abbr}
            maxLength={4}
            onChange={(e) => onChange({ ...value, abbr: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
            aria-label={`${label} abbreviation`}
            required
          />
          <input
            placeholder="Team name"
            value={value.name}
            maxLength={40}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            aria-label={`${label} name`}
            required
          />
          <input type="color" value={value.color} onChange={(e) => onChange({ ...value, color: e.target.value })} aria-label={`${label} color`} />
        </div>
      )}
    </fieldset>
  );
}

const blankTeam: AdminTeam = { abbr: '', name: '', color: '#3a7bd5' };

function GameForm({ run, busy }: { run: (a: AdminAction) => Promise<boolean>; busy: boolean }) {
  const [sport, setSport] = useState<AdminSport>('NBA');
  const [away, setAway] = useState<AdminTeam>(blankTeam);
  const [home, setHome] = useState<AdminTeam>(blankTeam);
  const [when, setWhen] = useState(() => toLocalInput(Math.ceil((Date.now() + 2 * 3600_000) / 900_000) * 900_000));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run({ action: 'createGame', game: { sport, away, home, startsAt: new Date(when).getTime() } });
    if (ok) {
      setAway(blankTeam);
      setHome(blankTeam);
    }
  };

  return (
    <form className="adm-card adm-form" onSubmit={submit}>
      <header className="adm-card-head">
        <h2>Add a game</h2>
      </header>
      <div className="field" role="group" aria-labelledby="adm-sport-label">
        <span id="adm-sport-label">Sport</span>
        <div className="seg seg-sports">
          {SPORTS.filter((s) => !REAL_MONEY || s.id === 'NBA' || s.id === 'NFL').map((s) => (
            <button
              key={s.id}
              type="button"
              className={sport === s.id ? 'on' : ''}
              onClick={() => {
                setSport(s.id as AdminSport);
                setAway(blankTeam);
                setHome(blankTeam);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <TeamPicker key={`a-${sport}`} sport={sport} value={away} onChange={setAway} label="Away team" />
      <TeamPicker key={`h-${sport}`} sport={sport} value={home} onChange={setHome} label="Home team" />
      <label className="field">
        <span>Start time</span>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
      </label>
      <button type="submit" className="cta" disabled={busy}>
        <span>Add game</span>
        <Icon name="plus" size={18} strokeWidth={2.5} />
      </button>
    </form>
  );
}

function GamesTab({ data, now, run, busy, go }: { data: AdminData; now: number; run: (a: AdminAction) => Promise<boolean>; busy: boolean; go: (t: Tab, g?: string) => void }) {
  const [filter, setFilter] = useState<Phase | 'all'>('all');
  const games = useMemo(() => {
    const order: Record<Phase, number> = { live: 0, upcoming: 1, final: 2, cancelled: 3 };
    return [...data.games]
      .filter((g) => filter === 'all' || phaseOf(g, now) === filter)
      .sort((a, b) => order[phaseOf(a, now)] - order[phaseOf(b, now)] || a.startsAt - b.startsAt);
  }, [data.games, filter, now]);

  return (
    <div className="adm-split">
      <GameForm run={run} busy={busy} />
      <section className="adm-card">
        <header className="adm-card-head">
          <h2>Games</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Phase | 'all')} aria-label="Filter games">
            <option value="all">All</option>
            <option value="live">In progress</option>
            <option value="upcoming">Upcoming</option>
            <option value="final">Final</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </header>
        {games.length === 0 ? (
          <p className="adm-empty">No games yet.</p>
        ) : (
          <ul className="adm-rows">
            {games.map((g) => {
              const phase = phaseOf(g, now);
              const count = data.picks.filter((p) => p.gameId === g.id).length;
              return (
                <li key={g.id} className="adm-row">
                  <div className="adm-row-main">
                    <Matchup g={g} />
                    <span className="muted small">
                      {g.away.name} at {g.home.name}
                    </span>
                    <span className="small">
                      <span className={`phase ${phase}`}>{PHASE_LABEL[phase]}</span> · {gameTime(g.startsAt, now)}
                    </span>
                  </div>
                  <div className="adm-row-actions">
                    <button type="button" className="adm-count" onClick={() => go('picks', g.id)}>
                      {count} pick{count === 1 ? '' : 's'}
                    </button>
                    {g.status === 'scheduled' && phase === 'live' && (
                      <button type="button" className="pill-btn sm" disabled={busy} onClick={() => run({ action: 'updateGame', id: g.id, patch: { status: 'final' } })}>
                        Mark final
                      </button>
                    )}
                    {g.status === 'scheduled' && (
                      <button
                        type="button"
                        className="ghost-sm"
                        disabled={busy}
                        onClick={() => confirm(`Cancel ${g.away.abbr} @ ${g.home.abbr}? Its picks leave the board.`) && run({ action: 'updateGame', id: g.id, patch: { status: 'cancelled' } })}
                      >
                        Cancel
                      </button>
                    )}
                    {g.status !== 'scheduled' && (
                      <button type="button" className="ghost-sm" disabled={busy} onClick={() => run({ action: 'updateGame', id: g.id, patch: { status: 'scheduled' } })}>
                        Reopen
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label="Delete game"
                      disabled={busy}
                      onClick={() => confirm(`Delete ${g.away.abbr} @ ${g.home.abbr} and its ${count} pick(s)?`) && run({ action: 'deleteGame', id: g.id })}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Picks                                                              */
/* ------------------------------------------------------------------ */

function PickForm({ data, now, run, busy, presetGame }: { data: AdminData; now: number; run: (a: AdminAction) => Promise<boolean>; busy: boolean; presetGame: string | null }) {
  const open = data.games.filter((g) => g.status === 'scheduled' && g.startsAt > now).sort((a, b) => a.startsAt - b.startsAt);
  const [gameId, setGameId] = useState(presetGame && open.some((g) => g.id === presetGame) ? presetGame : open[0]?.id ?? '');
  const game = open.find((g) => g.id === gameId);
  const [side, setSide] = useState<'away' | 'home'>('away');
  const [playerName, setPlayerName] = useState('');
  const [position, setPosition] = useState('');
  const [number, setNumber] = useState('');
  const [statType, setStatType] = useState('');
  const [line, setLine] = useState('');
  const [special, setSpecial] = useState(true);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (presetGame && open.some((g) => g.id === presetGame)) setGameId(presetGame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetGame]);
  useEffect(() => {
    if (!game && open[0]) setGameId(open[0].id);
  }, [game, open]);

  const sportCfg = game ? sportById(game.sport as never) : undefined;
  const stats = useMemo(() => [...new Set(Object.values(sportCfg?.stats ?? {}).flat().map((s) => s.stat))], [sportCfg]);
  const lineNum = Number(line);
  const lineProblem = line === '' ? null : lineError(lineNum, REAL_MONEY);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!game) return;
    const ok = await run({
      action: 'createPick',
      pick: {
        gameId: game.id,
        side,
        playerName,
        position,
        number: number === '' ? undefined : Number(number),
        statType,
        line: lineNum,
        special,
        note: note || undefined,
      },
    });
    if (ok) {
      setPlayerName('');
      setNumber('');
      setLine('');
      setNote('');
    }
  };

  if (open.length === 0)
    return (
      <section className="adm-card adm-form">
        <header className="adm-card-head">
          <h2>Add a pick</h2>
        </header>
        <p className="adm-empty">Add an upcoming game first. Picks are attached to a game.</p>
      </section>
    );

  return (
    <form className="adm-card adm-form" onSubmit={submit}>
      <header className="adm-card-head">
        <h2>Add a pick</h2>
      </header>
      <label className="field">
        <span>Game</span>
        <select value={gameId} onChange={(e) => setGameId(e.target.value)} required>
          {open.map((g) => (
            <option key={g.id} value={g.id}>
              {sportById(g.sport as never)?.label} · {g.away.abbr} @ {g.home.abbr} · {gameTime(g.startsAt, now)}
            </option>
          ))}
        </select>
      </label>
      {game && (
        <div className="field">
          <span>Player’s team</span>
          <div className="seg">
            {(['away', 'home'] as const).map((s) => (
              <button key={s} type="button" className={side === s ? 'on' : ''} onClick={() => setSide(s)}>
                <i className="swatch" style={{ background: game[s].color } as CSSProperties} />
                {game[s].abbr}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="field-row">
        <label className="field grow">
          <span>Player name</span>
          <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} maxLength={40} required placeholder="e.g. Jalen Carver" />
        </label>
        <label className="field w-sm">
          <span>Pos</span>
          <input value={position} onChange={(e) => setPosition(e.target.value.toUpperCase())} maxLength={4} required list="adm-positions" />
          <datalist id="adm-positions">
            {sportCfg?.positions.map((p) => <option key={p} value={p} />)}
          </datalist>
        </label>
        <label className="field w-sm">
          <span>#</span>
          <input type="number" min={0} max={99} value={number} onChange={(e) => setNumber(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      <div className="field-row">
        <label className="field grow">
          <span>Stat</span>
          <input value={statType} onChange={(e) => setStatType(e.target.value)} maxLength={30} required list="adm-stats" placeholder="e.g. Points" />
          <datalist id="adm-stats">
            {stats.map((s) => <option key={s} value={s} />)}
          </datalist>
        </label>
        <label className="field w-md">
          <span>Line</span>
          <input type="number" step={0.5} min={0.5} value={line} onChange={(e) => setLine(e.target.value)} required inputMode="decimal" placeholder="24.5" />
        </label>
      </div>
      {lineProblem && <p className="field-hint bad">{lineProblem}</p>}
      <label className="switch">
        <input type="checkbox" checked={special} onChange={(e) => setSpecial(e.target.checked)} />
        <span className="switch-ui" aria-hidden />
        <span>
          <strong>Special pick</strong>
          <small>Featured in the Specials tab with a star</small>
        </span>
      </label>
      <label className="field">
        <span>
          Your take <small className="muted">(optional, shown on the card)</small>
        </span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} rows={2} placeholder="e.g. Faced this defense twice, cleared 28 both times." />
        <small className="field-hint">{note.length}/140</small>
      </label>
      <button type="submit" className="cta" disabled={busy || !!lineProblem}>
        <span>Post pick</span>
        <Icon name="plus" size={18} strokeWidth={2.5} />
      </button>
    </form>
  );
}

function ResultInput({ pick, busy, run }: { pick: AdminPick; busy: boolean; run: (a: AdminAction) => Promise<boolean> }) {
  const [v, setV] = useState(pick.actual === undefined ? '' : String(pick.actual));
  useEffect(() => setV(pick.actual === undefined ? '' : String(pick.actual)), [pick.actual]);
  const dirty = v !== (pick.actual === undefined ? '' : String(pick.actual));
  return (
    <form
      className="result-input"
      onSubmit={(e) => {
        e.preventDefault();
        run({ action: 'updatePick', id: pick.id, patch: { actual: v === '' ? null : Number(v) } });
      }}
    >
      <input type="number" min={0} step="any" value={v} onChange={(e) => setV(e.target.value)} placeholder="Final" aria-label={`Final ${pick.statType} for ${pick.playerName}`} inputMode="decimal" />
      <button type="submit" className="pill-btn sm" disabled={busy || !dirty}>
        Save
      </button>
    </form>
  );
}

function PicksTab({ data, now, run, busy, gameFilter, setGameFilter }: { data: AdminData; now: number; run: (a: AdminAction) => Promise<boolean>; busy: boolean; gameFilter: string | null; setGameFilter: (g: string | null) => void }) {
  const games = new Map(data.games.map((g) => [g.id, g]));
  const [onlySpecial, setOnlySpecial] = useState(false);
  const picks = [...data.picks]
    .filter((p) => (!gameFilter || p.gameId === gameFilter) && (!onlySpecial || p.special))
    .sort((a, b) => (games.get(a.gameId)?.startsAt ?? 0) - (games.get(b.gameId)?.startsAt ?? 0) || b.createdAt - a.createdAt);

  return (
    <div className="adm-split">
      <PickForm data={data} now={now} run={run} busy={busy} presetGame={gameFilter} />
      <section className="adm-card">
        <header className="adm-card-head wrap">
          <h2>Picks</h2>
          <div className="adm-filters">
            <select value={gameFilter ?? ''} onChange={(e) => setGameFilter(e.target.value || null)} aria-label="Filter by game">
              <option value="">All games</option>
              {data.games.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.away.abbr} @ {g.home.abbr} · {gameTime(g.startsAt, now)}
                </option>
              ))}
            </select>
            <button type="button" className={`chip ${onlySpecial ? 'on' : ''}`} onClick={() => setOnlySpecial((s) => !s)}>
              <Icon name="star" size={13} strokeWidth={2.5} /> Specials
            </button>
          </div>
        </header>
        {picks.length === 0 ? (
          <p className="adm-empty">No picks yet.</p>
        ) : (
          <ul className="adm-rows">
            {picks.map((p) => {
              const g = games.get(p.gameId);
              if (!g) return null;
              const team = g[p.side];
              const started = g.startsAt <= now || g.status === 'final';
              const res = p.actual === undefined ? null : p.actual > p.line ? 'more' : 'less';
              return (
                <li key={p.id} className={`adm-row pick-row ${p.active ? '' : 'inactive'}`}>
                  <div className="adm-row-main">
                    <span className="pick-title">
                      <span className="swatch" style={{ background: team.color }} />
                      <strong>{p.playerName}</strong>
                      <span className="muted small">
                        {team.abbr} {p.position}
                        {p.number !== undefined ? ` #${p.number}` : ''}
                      </span>
                    </span>
                    <span className="pick-line">
                      <b>{p.line}</b> {p.statType}
                      <span className="muted small"> · {g.away.abbr} @ {g.home.abbr}</span>
                    </span>
                    {p.note && <span className="muted small pick-note">“{p.note}”</span>}
                    {res && (
                      <span className={`res-tag ${res}`}>
                        Final {p.actual} · {res === 'more' ? 'More' : 'Less'} wins
                      </span>
                    )}
                  </div>
                  <div className="adm-row-actions">
                    {(started || p.actual !== undefined) && g.status !== 'cancelled' && <ResultInput pick={p} busy={busy} run={run} />}
                    {p.actual === undefined && g.status === 'scheduled' && (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Change the line for ${p.playerName}`}
                        disabled={busy}
                        onClick={() => {
                          const v = prompt(`New line for ${p.playerName} ${p.statType} (now ${p.line}). Entries already placed keep the line they locked in.`, String(p.line));
                          if (v !== null && v.trim() !== '' && Number(v) !== p.line) run({ action: 'updatePick', id: p.id, patch: { line: Number(v) } });
                        }}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                    )}
                    <button
                      type="button"
                      className={`icon-btn ${p.special ? 'starred' : ''}`}
                      aria-label={p.special ? 'Remove from specials' : 'Make special'}
                      aria-pressed={p.special}
                      disabled={busy}
                      onClick={() => run({ action: 'updatePick', id: p.id, patch: { special: !p.special } })}
                    >
                      <Icon name="star" size={17} strokeWidth={2.25} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={p.active ? 'Hide from players' : 'Show to players'}
                      aria-pressed={!p.active}
                      disabled={busy}
                      onClick={() => run({ action: 'updatePick', id: p.id, patch: { active: !p.active } })}
                    >
                      <Icon name={p.active ? 'eye' : 'eyeOff'} size={17} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label="Delete pick"
                      disabled={busy}
                      onClick={() => confirm(`Delete ${p.playerName} ${p.line} ${p.statType}?`) && run({ action: 'deletePick', id: p.id })}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

export function Admin() {
  const { now, setAdminData, notify, session } = useStore();
  const [pass, setPass] = useState<string | null>(REAL_MONEY ? null : savedPassword);
  const [data, setData] = useState<AdminData>(EMPTY_DATA);
  const [storage, setStorage] = useState<string>('');
  const [checking, setChecking] = useState(REAL_MONEY || !!savedPassword());
  const [operatorError, setOperatorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const tab = ([...['overview', 'games', 'picks'], ...(REAL_MONEY ? ['players', 'payments', 'compliance', 'audit'] : [])].includes(params.get('tab') ?? '') ? params.get('tab') : 'overview') as Tab;
  const gameFilter = params.get('game');

  const go = useCallback(
    (t: Tab, gameId?: string) => {
      const next: Record<string, string> = { tab: t };
      if (gameId) next.game = gameId;
      setParams(next);
      window.scrollTo({ top: 0 });
    },
    [setParams],
  );

  const accept = useCallback(
    (d: AdminData) => {
      setData(d);
      setAdminData(d);
    },
    [setAdminData],
  );

  // Real money: the signed-in account must be an operator (checked on the server).
  useEffect(() => {
    if (!REAL_MONEY) return;
    let alive = true;
    (async () => {
      const t = await operatorToken();
      if (!t) {
        if (alive) {
          setPass(null);
          setChecking(false);
        }
        return;
      }
      try {
        const r = await adminLogin(t);
        if (!alive) return;
        accept(r.data);
        setStorage(r.storage);
        setPass('operator');
        setOperatorError(null);
      } catch (e) {
        if (alive) setOperatorError((e as Error).message);
      } finally {
        if (alive) setChecking(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [accept, session]);

  // Re-validate a remembered password on load
  useEffect(() => {
    if (REAL_MONEY) return;
    const p = savedPassword();
    if (!p) return;
    adminLogin(p)
      .then((r) => {
        accept(r.data);
        setStorage(r.storage);
      })
      .catch(() => {
        rememberPassword(null);
        setPass(null);
      })
      .finally(() => setChecking(false));
  }, [accept]);

  const run = useCallback(
    async (action: AdminAction): Promise<boolean> => {
      if (!pass) return false;
      setBusy(true);
      setError(null);
      try {
        const credential = REAL_MONEY ? (await operatorToken()) ?? '' : pass;
        const r = await adminDo(credential, action, data.version);
        accept(r.data);
        notify('Saved');
        return true;
      } catch (e) {
        const err = e as AdminError;
        if (err.data) accept(err.data);
        if (err.status === 401 && !REAL_MONEY) {
          rememberPassword(null);
          setPass(null);
        }
        setError(err.message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [pass, data.version, accept, notify],
  );

  if (checking) return <div className="page"><p className="muted">Checking admin session…</p></div>;

  if (REAL_MONEY && !pass)
    return (
      <div className="page narrow">
        <header className="page-head">
          <h1>Admin</h1>
        </header>
        <div className="adm-card adm-login">
          <div className="adm-login-ico">
            <Icon name="shield" size={22} />
          </div>
          {session ? (
            <p>{operatorError ?? 'This account doesn’t have operator access.'} Signed in as <strong>{session.email}</strong>.</p>
          ) : (
            <p>Sign in with your operator account to open the dashboard.</p>
          )}
          {!session && (
            <Link to="/login?next=/admin" className="cta">
              <span>Sign in</span>
              <Icon name="arrow" size={18} />
            </Link>
          )}
        </div>
      </div>
    );

  if (!pass)
    return (
      <Login
        onDone={(p, d, s) => {
          setPass(p);
          accept(d);
          setStorage(s);
        }}
      />
    );

  return (
    <div className="page admin">
      <header className="page-head adm-head">
        <div>
          <p className="eyebrow">
            <Icon name="shield" size={12} strokeWidth={2.5} /> Admin dashboard
          </p>
          <h1>House control</h1>
        </div>
        <div className="adm-head-actions">
          <Link to="/board?sport=SPECIALS" className="ghost-sm">
            View as player
          </Link>
          {!REAL_MONEY && (
          <button
            type="button"
            className="ghost-sm"
            onClick={() => {
              rememberPassword(null);
              setPass(null);
            }}
          >
            <Icon name="logout" size={15} /> Sign out
          </button>
          )}
        </div>
      </header>

      {storage === 'file' && (
        <p className="adm-banner">Local development mode: data is saved to <code>.data/admin.json</code> on this machine.</p>
      )}

      <div className="seg seg-tabs adm-tabs" role="tablist">
        {(['overview', ...(REAL_MONEY ? ['players'] : []), 'games', 'picks', ...(REAL_MONEY ? ['payments', 'compliance', 'audit'] : [])] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => go(t)}>
            {t === 'overview' ? 'Overview' : t === 'players' ? 'Players' : t === 'games' ? 'Games' : t === 'picks' ? 'Picks' : t === 'payments' ? 'Payments' : t === 'compliance' ? 'Compliance' : 'Audit log'}
            <span className="cnt">{t === 'games' ? data.games.length : t === 'picks' ? data.picks.length : ''}</span>
          </button>
        ))}
      </div>

      {error && (
        <p className="ticket-error adm-error" role="alert">
          {error}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setError(null)}>
            <Icon name="close" size={14} />
          </button>
        </p>
      )}

      {storage === 'supabase' && (
        <p className="adm-banner">Real money: games and lines are live in the database. Posting a final stat settles players’ entries and pays out from the ledger. Results can’t be changed once posted.</p>
      )}
      {tab === 'overview' && <Overview data={data} now={now} go={go} />}
      {tab === 'overview' && REAL_MONEY && (
        <div style={{ marginTop: 14 }}>
          <CreditFunds run={(body) => run(body as unknown as AdminAction)} />
        </div>
      )}
      {tab === 'compliance' && REAL_MONEY && <ComplianceTab notify={notify} />}
      {tab === 'payments' && REAL_MONEY && <PaymentsTab notify={notify} />}
      {tab === 'audit' && REAL_MONEY && <AuditTab />}
      {tab === 'players' && REAL_MONEY && <PlayersTab notify={notify} />}
      {tab === 'games' && <GamesTab data={data} now={now} run={run} busy={busy} go={go} />}
      {tab === 'picks' && (
        <PicksTab
          data={data}
          now={now}
          run={run}
          busy={busy}
          gameFilter={gameFilter}
          setGameFilter={(g) => setParams(g ? { tab: 'picks', game: g } : { tab: 'picks' })}
        />
      )}
    </div>
  );
}
