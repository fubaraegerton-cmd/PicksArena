import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { adminAction, adminView } from '../../lib/adminApi';
import { supabase } from '../../lib/supabase';

/** Operator console: player lookup and case management (phase 6). */

async function cred(): Promise<string> {
  return (await supabase?.auth.getSession())?.data.session?.access_token ?? '';
}

const usd = (c: number | string | null | undefined) => (c == null ? '—' : `$${(Number(c) / 100).toFixed(2)}`);
const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '—');
const ago = (s: string | null | undefined) => {
  if (!s) return 'never';
  const m = Math.round((Date.now() - Date.parse(s)) / 60_000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const age = (dob: string | null) => (dob ? Math.floor((Date.now() - Date.parse(dob)) / (365.25 * 864e5)) : null);

interface SearchRow {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  operator: boolean;
  profile: { state: string | null; kyc_status: string; flags: Record<string, unknown>; self_exclusion_until: string | null } | null;
  available_cents: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Detail = any;

function Section({ title, count, children, open = false }: { title: string; count?: number; children: ReactNode; open?: boolean }) {
  return (
    <details className="pd-section" open={open}>
      <summary>
        <h3>{title}</h3>
        {count !== undefined && <span className="cnt">{count}</span>}
      </summary>
      <div className="pd-body">{children}</div>
    </details>
  );
}

function PlayerDetail({ id, notify, onBack }: { id: string; notify: (m: string) => void; onBack: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setD(await adminView(await cred(), { view: 'player', id }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setErr(null);
    try {
      await adminAction(await cred(), body);
      notify(done);
      await load();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!d) return <p className="muted">{err ?? 'Loading player…'}</p>;
  const p = d.profile ?? {};
  const flags = Object.entries(p.flags ?? {}).filter(([, v]) => v === true).map(([k]) => k);
  const blocked = p.flags?.blocked === true;
  const excluded = p.self_exclusion_until && (p.self_exclusion_until === 'infinity' || Date.parse(p.self_exclusion_until) > Date.now());

  return (
    <div className="adm-stack">
      <button type="button" className="text-btn" onClick={onBack}>
        Back to search
      </button>
      {err && <p className="ticket-error">{err}</p>}

      <section className="adm-card pd-head">
        <div>
          <h2 className="pd-email">{d.user.email}</h2>
          <p className="muted small">
            Joined {dt(d.user.created_at)}, last sign-in {ago(d.user.last_sign_in_at)}
            {d.user.operator ? ', operator' : ''}
          </p>
          <div className="pd-tags">
            <span className="pd-tag">Age {age(p.dob) ?? '—'}</span>
            <span className="pd-tag">Home {p.state ?? '—'}</span>
            <span className={`pd-tag ${p.kyc_status === 'approved' ? 'ok' : ''}`}>ID check {p.kyc_status ?? 'none'}</span>
            {excluded && <span className="pd-tag warn">{p.self_exclusion_until === 'infinity' ? 'Self-excluded (permanent)' : `Excluded until ${dt(p.self_exclusion_until)}`}</span>}
            {flags.map((f) => (
              <span key={f} className="pd-tag warn">
                {f.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
        <div className="pd-wallet">
          <div>
            <span className="eyebrow">Available</span>
            <strong>{usd(d.wallet.available_cents)}</strong>
          </div>
          <div>
            <span className="eyebrow">Held</span>
            <strong>{usd(d.wallet.held_cents)}</strong>
          </div>
          <div>
            <span className="eyebrow">In play</span>
            <strong>{usd(d.wallet.in_play_cents)}</strong>
          </div>
        </div>
        <div className="adm-row-actions">
          <button
            type="button"
            className={blocked ? 'ghost-sm' : 'pill-btn sm'}
            disabled={busy}
            onClick={() => act({ action: 'setBlocked', userId: id, blocked: !blocked }, blocked ? 'Hold removed' : 'Account on hold')}
          >
            {blocked ? 'Remove hold' : 'Put on hold'}
          </button>
          <button
            type="button"
            className="ghost-sm"
            disabled={busy}
            onClick={() => {
              const amount = prompt('Adjust balance by how many dollars? Use a negative number to debit.');
              if (!amount) return;
              const reason = prompt('Reason (stored on the ledger):');
              if (reason) act({ action: 'creditFunds', email: d.user.email, amountCents: Math.round(Number(amount) * 100), reason }, 'Balance adjusted');
            }}
          >
            Adjust balance
          </button>
        </div>
      </section>

      <section className="adm-card">
        <form
          className="pd-note"
          onSubmit={async (e: FormEvent) => {
            e.preventDefault();
            if (await act({ action: 'addNote', userId: id, note }, 'Note added')) setNote('');
          }}
        >
          <label className="field">
            <span>Case note</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called the player about the name on their card." maxLength={2000} />
          </label>
          <button type="submit" className="pill-btn sm" disabled={busy || note.trim().length < 3}>
            Add note
          </button>
        </form>
      </section>

      <Section title="Entries" count={d.entries.length} open>
        {d.entries.length === 0 ? (
          <p className="adm-empty">No entries.</p>
        ) : (
          <ul className="adm-rows">
            {d.entries.map((e: Detail) => (
              <li key={e.id} className="adm-row pd-entry">
                <div className="adm-row-main">
                  <span className="pick-title">
                    <strong>
                      {e.pick_count}-pick, {usd(e.stake_cents)}
                    </strong>
                    <span className={`pay-status s-${e.status === 'won' ? 'paid' : e.status === 'lost' ? 'failed' : e.status}`}>{e.status}</span>
                    <span className="muted small">
                      {dt(e.created_at)}, {e.status === 'open' ? `pays ${usd(e.potential_payout_cents)}` : `paid ${usd(e.payout_cents)}`}
                    </span>
                  </span>
                  <ul className="pd-legs">
                    {e.entry_picks.map((l: Detail) => (
                      <li key={l.projection_id}>
                        <span>
                          {l.projections?.player_name} ({l.projections?.team}) {l.direction} {l.line} {l.projections?.stat_type}
                        </span>
                        <span className={`res-tag ${l.result === 'hit' ? 'more' : l.result === 'miss' ? 'less' : ''}`}>
                          {l.result}
                          {l.final_value != null ? ` (${l.final_value})` : ''}
                        </span>
                        {e.status === 'open' && l.result === 'pending' && (
                          <select
                            aria-label="Force-settle this leg"
                            disabled={busy}
                            value=""
                            onChange={(ev) => {
                              const result = ev.target.value;
                              if (!result) return;
                              const reason = prompt(`Force this leg to "${result}". Reason (stored in the audit log):`);
                              if (reason) act({ action: 'forceSettleLeg', entryId: e.id, projectionId: l.projection_id, result, reason }, 'Leg settled');
                            }}
                          >
                            <option value="">Force-settle…</option>
                            <option value="hit">Hit</option>
                            <option value="miss">Miss</option>
                            <option value="void">Void (drop the leg)</option>
                          </select>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Ledger statement" count={d.ledger.length}>
        <table className="sport-table geo-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Type</th>
              <th scope="col">Account</th>
              <th scope="col">Amount</th>
              <th scope="col" className="hide-sm">Detail</th>
            </tr>
          </thead>
          <tbody>
            {d.ledger.map((l: Detail) => (
              <tr key={l.id}>
                <td>{dt(l.created_at)}</td>
                <td>{l.ledger_transactions?.kind}</td>
                <td>{String(l.account).replace('user_', '')}</td>
                <td className={l.amount_cents < 0 ? 'neg' : 'pos'}>{usd(l.amount_cents)}</td>
                <td className="hide-sm muted small">{l.ledger_transactions?.memo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Payments" count={d.payments.length}>
        <ul className="adm-rows">
          {d.payments.map((x: Detail) => (
            <li key={x.id} className="adm-row">
              <div className="adm-row-main">
                <span className="pick-title">
                  <strong>
                    {x.direction} {usd(x.amount_cents)}
                  </strong>
                  <span className={`pay-status s-${x.status}`}>{x.status}</span>
                </span>
                <span className="muted small">
                  {dt(x.created_at)}, {x.payment_methods?.label ?? x.provider}
                  {x.reviewed_by ? `, reviewed by ${x.reviewed_by}` : ''}
                  {x.failure_reason ? `. ${x.failure_reason}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Limits and breaks" count={d.limits.length + d.exclusions.length}>
        {d.limits.length === 0 && d.exclusions.length === 0 && <p className="adm-empty">No limits or breaks set.</p>}
        <ul className="adm-rows">
          {d.limits.map((l: Detail) => (
            <li key={`${l.kind}-${l.period}`} className="adm-row">
              <span>
                {l.kind} limit per {l.period}: <b>{l.current_cents === null ? 'none' : usd(l.current_cents)}</b>
                {l.pending ? `, changing to ${l.pending.amount_cents === null ? 'none' : usd(l.pending.amount_cents)} on ${dt(l.pending.effective_at)}` : ''}
              </span>
            </li>
          ))}
          {d.exclusions.map((x: Detail, i: number) => (
            <li key={i} className="adm-row">
              <span>
                {x.kind.replace('_', ' ')} from {dt(x.starts_at)} until {x.ends_at === 'infinity' ? 'permanent' : dt(x.ends_at)} ({x.created_by})
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Identity checks" count={d.kyc.length}>
        <ul className="adm-rows">
          {d.kyc.map((k: Detail) => (
            <li key={k.id} className="adm-row">
              <span>
                <b>{k.status}</b> via {k.provider}, started {dt(k.created_at)}
                {k.decided_at ? `, decided ${dt(k.decided_at)} by ${k.decided_by}` : ''}
                {k.reason ? `. ${k.reason}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Devices and sessions" count={d.devices.length + d.sessions.length}>
        <ul className="adm-rows">
          {d.devices.map((x: Detail) => (
            <li key={x.device_hash} className="adm-row">
              <span>
                Device <code>{x.device_hash}</code>, first {dt(x.first_seen)}, last {ago(x.last_seen)}
                {x.shared_with > 0 && <b className="neg">, shared with {x.shared_with} other account{x.shared_with > 1 ? 's' : ''}</b>}
              </span>
            </li>
          ))}
          {d.sessions.map((x: Detail, i: number) => (
            <li key={i} className="adm-row">
              <span className="muted small">
                Session {dt(x.created_at)}, refreshed {ago(x.refreshed_at ?? x.updated_at)}
                {x.ip ? `, IP ${x.ip}` : ''}
                {x.user_agent ? `, ${String(x.user_agent).slice(0, 80)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Location checks" count={d.geo.length}>
        <table className="sport-table geo-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">Where</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {d.geo.map((g: Detail) => (
              <tr key={g.id}>
                <td>{dt(g.created_at)}</td>
                <td>{g.action}</td>
                <td>{[g.region, g.country].filter(Boolean).join(', ') || 'unknown'}</td>
                <td className={g.decision === 'deny' ? 'neg' : ''}>
                  {g.decision}
                  {g.reason ? ` (${g.reason.replace(/_/g, ' ')})` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Audit trail" count={d.audit.length}>
        <ul className="audit-rows">
          {d.audit.map((a: Detail) => (
            <li key={a.id}>
              <span className="audit-when">{dt(a.at)}</span>
              <strong>{a.action}</strong>
              <span className="muted small">by {a.actor}</span>
              <code className="audit-details">{JSON.stringify(a.details)}</code>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export function PlayersTab({ notify }: { notify: (m: string) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SearchRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (selected) return <PlayerDetail id={selected} notify={notify} onBack={() => setSelected(null)} />;

  return (
    <section className="adm-card">
      <header className="adm-card-head">
        <h2>Find a player</h2>
      </header>
      <form
        className="pd-search"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            setRows((await adminView<{ players: SearchRow[] }>(await cred(), { view: 'players', q })).players);
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      >
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email or part of it, or a player ID" aria-label="Search players" />
        <button type="submit" className="pill-btn sm" disabled={q.trim().length < 2}>
          Search
        </button>
      </form>
      {err && <p className="ticket-error">{err}</p>}
      {rows && rows.length === 0 && <p className="adm-empty">No players match.</p>}
      {rows && rows.length > 0 && (
        <ul className="adm-rows">
          {rows.map((r) => {
            const flags = Object.entries(r.profile?.flags ?? {}).filter(([, v]) => v === true).map(([k]) => k);
            return (
              <li key={r.id} className="adm-row">
                <div className="adm-row-main">
                  <strong>{r.email}</strong>
                  <span className="muted small">
                    {r.profile?.state ?? 'no state'}, ID check {r.profile?.kyc_status ?? 'none'}, balance {usd(r.available_cents)}, last sign-in {ago(r.last_sign_in_at)}
                    {r.operator ? ', operator' : ''}
                    {flags.length ? `. Flags: ${flags.join(', ')}` : ''}
                  </span>
                </div>
                <div className="adm-row-actions">
                  <button type="button" className="pill-btn sm" onClick={() => setSelected(r.id)}>
                    Open
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function OperatorsCard({ notify }: { notify: (m: string) => void }) {
  const [ops, setOps] = useState<{ id: string; email: string; via: string; last_sign_in_at: string | null }[] | null>(null);
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setOps((await adminView<{ operators: typeof ops }>(await cred(), { view: 'operators' })).operators);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const set = async (target: string, grant: boolean) => {
    setErr(null);
    try {
      await adminAction(await cred(), { action: 'setOperator', email: target, grant });
      notify(grant ? 'Operator access granted' : 'Operator access removed');
      setEmail('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <section className="adm-card">
      <header className="adm-card-head">
        <h2>Operators</h2>
        <span className="muted">{ops?.length ?? 0}</span>
      </header>
      <p className="muted small">People who can open this dashboard. Granting and removing access is recorded in the audit log.</p>
      {err && <p className="ticket-error">{err}</p>}
      <ul className="adm-rows">
        {(ops ?? []).map((o) => (
          <li key={o.id} className="adm-row">
            <div className="adm-row-main">
              <strong>{o.email}</strong>
              <span className="muted small">
                {o.via === 'console' ? 'Granted here' : 'Listed in OPERATOR_EMAILS'}, last sign-in {ago(o.last_sign_in_at)}
              </span>
            </div>
            {o.via === 'console' && (
              <div className="adm-row-actions">
                <button type="button" className="ghost-sm" onClick={() => confirm(`Remove operator access for ${o.email}?`) && set(o.email, false)}>
                  Remove
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        className="pd-search"
        onSubmit={(e) => {
          e.preventDefault();
          set(email, true);
        }}
      >
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email of an existing account" aria-label="Grant operator access to" required />
        <button type="submit" className="pill-btn sm">
          Grant access
        </button>
      </form>
    </section>
  );
}
