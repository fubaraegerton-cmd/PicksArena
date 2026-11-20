import type { User } from '@supabase/supabase-js';
import { audit, db } from './supabase.js';

/**
 * Operator console (phase 6): player lookup and case actions. Every action is audited
 * with the operator's identity (handlers.ts adds an operator.<action> row; the database
 * functions add their own detail rows).
 */

export class ConsoleError extends Error {}

async function allUsers(): Promise<User[]> {
  const out: User[] = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db().auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    out.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return out;
}

/** Search by email fragment or exact user id. */
export async function playerSearch(q: string) {
  const term = q.trim().toLowerCase();
  if (term.length < 2) return { players: [] };
  const users = await allUsers();
  const hits = users
    .filter((u) => u.id === term || (u.email ?? '').toLowerCase().includes(term))
    .slice(0, 25);
  const ids = hits.map((u) => u.id);
  const [profiles, wallets] = await Promise.all([
    ids.length ? db().from('profiles').select('id, state, kyc_status, flags, self_exclusion_until').in('id', ids) : Promise.resolve({ data: [] }),
    ids.length ? db().from('wallets').select('user_id, available_cents').in('user_id', ids) : Promise.resolve({ data: [] }),
  ]);
  const prof = new Map((profiles.data ?? []).map((p) => [p.id, p]));
  const wal = new Map((wallets.data ?? []).map((w) => [w.user_id, w]));
  return {
    players: hits.map((u) => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      operator: isOperatorUser(u),
      profile: prof.get(u.id) ?? null,
      available_cents: Number(wal.get(u.id)?.available_cents ?? 0),
    })),
  };
}

export function bootstrapOperatorEmails(): string[] {
  return (process.env.OPERATOR_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Operator = app_metadata.role 'operator' (set by the console) or a confirmed email listed in OPERATOR_EMAILS. */
export function isOperatorUser(u: User | null | undefined): boolean {
  if (!u) return false;
  if (u.app_metadata?.role === 'operator') return true;
  return !!u.email && !!u.email_confirmed_at && bootstrapOperatorEmails().includes(u.email.toLowerCase());
}

const PERIOD_MS = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 } as const;

/** Everything about one player, for the console's player page. */
export async function playerDetail(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ConsoleError('Unknown player.');
  const { data: u, error: ue } = await db().auth.admin.getUserById(id);
  if (ue || !u.user) throw new ConsoleError('Unknown player.');
  const accounts = await db().from('ledger_accounts').select('id, kind').eq('user_id', id);
  const accountIds = (accounts.data ?? []).map((a) => a.id);
  const now = Date.now();

  const [profile, wallet, limits, exclusions, entries, postings, payments, kyc, devices, geo, sessions, trail] = await Promise.all([
    db().from('profiles').select('*').eq('id', id).maybeSingle(),
    db().from('wallets').select('available_cents, held_cents, in_play_cents').eq('user_id', id).maybeSingle(),
    db().from('player_limits').select('id, kind, period, amount_cents, effective_at, created_by').eq('user_id', id).order('id', { ascending: false }),
    db().from('player_exclusions').select('kind, starts_at, ends_at, created_by').eq('user_id', id).order('id', { ascending: false }).limit(20),
    db()
      .from('entries')
      .select('id, created_at, stake_cents, pick_count, multiplier, potential_payout_cents, status, payout_cents, settled_at, entry_picks(projection_id, direction, line, result, final_value, projections(player_name, team, stat_type, status))')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(50),
    accountIds.length
      ? db()
          .from('ledger_postings')
          .select('id, amount_cents, created_at, account_id, ledger_transactions(kind, memo, idempotency_key, entry_id, payment_ref)')
          .in('account_id', accountIds)
          .order('id', { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [] }),
    db().from('payments').select('id, direction, amount_cents, status, provider, provider_ref, failure_reason, created_at, reviewed_by, payment_methods(label, status)').eq('user_id', id).order('created_at', { ascending: false }).limit(50),
    db().from('kyc_records').select('id, provider, status, reason, created_at, decided_at, decided_by').eq('user_id', id).order('id', { ascending: false }),
    db().from('devices').select('device_hash, first_seen, last_seen').eq('user_id', id).order('last_seen', { ascending: false }),
    db().from('geo_checks').select('id, action, decision, reason, region, country, is_vpn, ip, created_at').eq('user_id', id).order('id', { ascending: false }).limit(50),
    db().rpc('player_sessions', { p_user: id }),
    db().from('audit_log').select('id, at, actor, action, details').eq('subject_user', id).order('id', { ascending: false }).limit(100),
  ]);

  // How many other accounts share each of this player's devices
  const hashes = (devices.data ?? []).map((d) => d.device_hash as string);
  const shared = hashes.length ? await db().from('devices').select('device_hash, user_id').in('device_hash', hashes).neq('user_id', id) : { data: [] };
  const sharedBy = new Map<string, string[]>();
  for (const r of shared.data ?? []) sharedBy.set(r.device_hash as string, [...(sharedBy.get(r.device_hash as string) ?? []), r.user_id as string]);

  const kindOf = new Map((accounts.data ?? []).map((a) => [a.id, a.kind as string]));
  const limitRows = limits.data ?? [];
  const currentLimits = (['deposit', 'stake', 'loss'] as const).flatMap((kind) =>
    (['day', 'week', 'month'] as const).map((period) => {
      const mine = limitRows.filter((l) => l.kind === kind && l.period === period);
      const current = mine.find((l) => Date.parse(l.effective_at) <= now);
      const pending = mine.find((l) => Date.parse(l.effective_at) > now && (!current || l.id > current.id));
      return { kind, period, window_ms: PERIOD_MS[period], current_cents: current?.amount_cents ?? null, pending: pending ?? null };
    }),
  );

  return {
    user: {
      id: u.user.id,
      email: u.user.email,
      created_at: u.user.created_at,
      last_sign_in_at: u.user.last_sign_in_at,
      email_confirmed_at: u.user.email_confirmed_at,
      operator: isOperatorUser(u.user),
    },
    profile: profile.data,
    wallet: wallet.data ?? { available_cents: 0, held_cents: 0, in_play_cents: 0 },
    limits: currentLimits.filter((l) => l.current_cents !== null || l.pending),
    exclusions: exclusions.data ?? [],
    entries: entries.data ?? [],
    ledger: (postings.data ?? []).map((p) => ({ ...p, account: kindOf.get(p.account_id as number) ?? String(p.account_id) })),
    payments: payments.data ?? [],
    kyc: kyc.data ?? [],
    devices: (devices.data ?? []).map((d) => ({ ...d, device_hash: (d.device_hash as string).slice(0, 12), shared_with: sharedBy.get(d.device_hash as string)?.length ?? 0 })),
    geo: geo.data ?? [],
    sessions: sessions.error ? [] : (sessions.data ?? []),
    audit: trail.data ?? [],
  };
}

export async function forceSettleLeg(entryId: string, projectionId: string, result: string, reason: string, by: string) {
  const { error } = await db().rpc('force_settle_leg', { p_entry: entryId, p_projection: projectionId, p_result: result, p_reason: reason, p_by: by });
  if (error) {
    const map: [RegExp, string][] = [
      [/reason required/, 'Give a reason. It’s stored in the audit log.'],
      [/entry_already_settled/, 'That entry has already settled.'],
      [/leg_already_settled/, 'That leg already has a result.'],
      [/invalid_result/, 'Choose hit, miss or void.'],
    ];
    throw new ConsoleError(map.find(([re]) => re.test(error.message))?.[1] ?? error.message);
  }
}

export async function failPendingDeposit(paymentId: string, reason: string, by: string) {
  const { error } = await db().rpc('fail_pending_deposit', { p_payment: paymentId, p_reason: reason, p_by: by });
  if (error) throw new ConsoleError(/deposit_not_pending/.test(error.message) ? 'That deposit is no longer pending.' : /reason required/.test(error.message) ? 'Give a reason.' : error.message);
}

export async function addNote(userId: string, note: string, by: string) {
  const text = note.trim();
  if (text.length < 3 || text.length > 2000) throw new ConsoleError('Notes must be 3 to 2,000 characters.');
  await audit(by, 'operator.note', userId, { note: text });
}

/** Grants or revokes operator access. Operators can't revoke themselves (avoids locking the house out). */
export async function setOperator(email: string, grant: boolean, by: string, byEmail: string) {
  const target = (await allUsers()).find((u) => (u.email ?? '').toLowerCase() === email.trim().toLowerCase());
  if (!target) throw new ConsoleError('No account with that email. They need to sign up first.');
  if (!grant && target.email?.toLowerCase() === byEmail.toLowerCase()) throw new ConsoleError('You can’t remove your own operator access.');
  if (!grant && bootstrapOperatorEmails().includes((target.email ?? '').toLowerCase()))
    throw new ConsoleError('This operator is listed in OPERATOR_EMAILS in Vercel. Remove them there.');
  const meta = { ...(target.app_metadata ?? {}) } as Record<string, unknown>;
  if (grant) meta.role = 'operator';
  else delete meta.role;
  const { error } = await db().auth.admin.updateUserById(target.id, { app_metadata: meta });
  if (error) throw new ConsoleError(error.message);
  await audit(by, grant ? 'operator.granted' : 'operator.revoked', target.id, { email: target.email });
}

export async function listOperators() {
  return (await allUsers()).filter(isOperatorUser).map((u) => ({
    id: u.id,
    email: u.email,
    via: u.app_metadata?.role === 'operator' ? 'console' : 'OPERATOR_EMAILS',
    last_sign_in_at: u.last_sign_in_at,
  }));
}

export async function pendingDeposits(emails: Map<string, string>) {
  const { data, error } = await db()
    .from('payments')
    .select('id, user_id, amount_cents, provider, provider_ref, created_at')
    .eq('direction', 'deposit')
    .eq('status', 'created')
    .order('created_at')
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => ({ ...p, email: emails.get(p.user_id as string) ?? p.user_id }));
}
