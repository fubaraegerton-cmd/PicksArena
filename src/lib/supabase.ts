import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Direction, Entry, EntryPick, PickResult, Projection } from '../types';
import { SPORTS } from '../data/sports';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** Real-money mode is on when the build has Supabase settings. Otherwise the app runs as the play-money demo. */
export const REAL_MONEY = !!(URL && KEY);

/** Sports offered: real money is NBA and NFL only. */
export const PLAY_SPORTS = REAL_MONEY ? SPORTS.filter((s) => s.id === 'NBA' || s.id === 'NFL') : SPORTS;

export const supabase: SupabaseClient | null = REAL_MONEY
  ? createClient(URL!, KEY!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

async function token(): Promise<string | null> {
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

/** Stable random id for this browser, used server-side (hashed) to spot accounts sharing a device. */
export function deviceId(): string {
  try {
    let id = localStorage.getItem('picksarena:device');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('picksarena:device', id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const t = await token();
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-device-id': deviceId(),
        ...(t ? { authorization: `Bearer ${t}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('Can’t reach the server. Check your connection.', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code);
  return body as T;
}

export interface Profile {
  id: string;
  dob: string | null;
  state: string | null;
  kyc_status: string;
  self_exclusion_until: string | null;
}

export const getProfile = () => call<{ profile: Profile | null }>('/api/rm/profile');

export type KycStatus = 'none' | 'pending' | 'review' | 'approved' | 'rejected';
export const getKyc = () => call<{ available: boolean; status: KycStatus; reason: string | null }>('/api/rm/kyc');
export const startKyc = () => call<{ status: KycStatus; url?: string | null }>('/api/rm/kyc', { method: 'POST', body: '{}' });

/** States where real-money play is currently switched on (public, read via RLS). */
export async function eligibleStates(): Promise<{ state: string; name: string; min_age: number }[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('jurisdictions').select('state, name, min_age').eq('enabled', true).order('name');
  return data ?? [];
}
export const saveProfile = (dob: string, state: string) =>
  call<{ profile: Profile }>('/api/rm/profile', { method: 'POST', body: JSON.stringify({ dob, state }) });

/** Projection ids on the board are "adm-<uuid>"; the server wants the bare uuid. */
export const dbId = (projectionId: string) => projectionId.replace(/^adm-/, '');

export const placeEntry = (picks: { projectionId: string; direction: Direction }[], stakeCents: number, idempotencyKey: string) =>
  call<{ entry: { id: string } }>('/api/rm/entries', {
    method: 'POST',
    body: JSON.stringify({
      picks: picks.map((p) => ({ projection_id: dbId(p.projectionId), direction: p.direction })),
      stake_cents: stakeCents,
      idempotency_key: idempotencyKey,
    }),
  });

export interface Wallet {
  available: number; // dollars
  held: number;
  inPlay: number;
}

export async function fetchWallet(): Promise<Wallet> {
  const { data, error } = await supabase!.from('wallets').select('available_cents, held_cents, in_play_cents').maybeSingle();
  if (error) throw new Error(error.message);
  return {
    available: Number(data?.available_cents ?? 0) / 100,
    held: Number(data?.held_cents ?? 0) / 100,
    inPlay: Number(data?.in_play_cents ?? 0) / 100,
  };
}

interface EntryRow {
  id: string;
  created_at: string;
  stake_cents: number;
  pick_count: number;
  potential_payout_cents: number;
  status: 'open' | 'won' | 'lost' | 'refunded';
  payout_cents: number;
  entry_picks: {
    direction: Direction;
    line: number;
    result: 'pending' | 'hit' | 'miss' | 'push' | 'void';
    final_value: number | null;
    projections: {
      id: string;
      player_id: string;
      player_name: string;
      team: string;
      position: string;
      jersey: number | null;
      stat_type: string;
      games: {
        id: string;
        sport: 'NBA' | 'NFL';
        home_team: string;
        away_team: string;
        home_color: string | null;
        away_color: string | null;
        home_name: string | null;
        away_name: string | null;
        starts_at: string;
      };
    };
  }[];
}

/** The signed-in player's entries (RLS limits rows to their own), mapped to the app's Entry shape. */
export async function fetchEntries(): Promise<Entry[]> {
  const { data, error } = await supabase!
    .from('entries')
    .select(
      'id, created_at, stake_cents, pick_count, potential_payout_cents, status, payout_cents, entry_picks(direction, line, result, final_value, projections(id, player_id, player_name, team, position, jersey, stat_type, games(id, sport, home_team, away_team, home_color, away_color, home_name, away_name, starts_at)))',
    )
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data as unknown as EntryRow[]).map((e) => ({
    id: e.id,
    createdAt: Date.parse(e.created_at),
    playType: 'power',
    amount: Number(e.stake_cents) / 100,
    status: e.status,
    payout: Number(e.payout_cents) / 100,
    potentialPayout: Number(e.potential_payout_cents) / 100,
    picks: e.entry_picks.map((p): EntryPick => {
      const pr = p.projections;
      const g = pr.games;
      const home = { abbr: g.home_team, name: g.home_name ?? g.home_team, color: g.home_color ?? '#5b6573' };
      const away = { abbr: g.away_team, name: g.away_name ?? g.away_team, color: g.away_color ?? '#5b6573' };
      const isHome = pr.team === g.home_team;
      const projection: Projection = {
        id: `adm-${pr.id}`,
        source: 'admin',
        player: { id: pr.player_id, name: pr.player_name, position: pr.position, number: pr.jersey ?? undefined, team: isHome ? home : away, sport: g.sport },
        game: { id: `adm-${g.id}`, sport: g.sport, home, away, startsAt: Date.parse(g.starts_at) },
        opponent: isHome ? away : home,
        statType: pr.stat_type,
        line: Number(p.line),
        moreShare: 50,
      };
      return {
        projection,
        direction: p.direction,
        result: p.result as PickResult,
        actual: p.final_value === null ? undefined : Number(p.final_value),
      };
    }),
  }));
}

// ---------- payments (phase 4) ----------
export const startDeposit = (amountCents: number, idempotencyKey: string) =>
  call<{ redirectUrl: string; paymentId: string }>('/api/pay/deposit', {
    method: 'POST',
    body: JSON.stringify({ amount_cents: amountCents, idempotency_key: idempotencyKey }),
  });
export const requestWithdrawal = (amountCents: number, methodId: string, idempotencyKey: string) =>
  call<{ payment: { id: string; status: string } }>('/api/pay/withdraw', {
    method: 'POST',
    body: JSON.stringify({ amount_cents: amountCents, method_id: methodId, idempotency_key: idempotencyKey }),
  });
export const cancelWithdrawal = (paymentId: string) =>
  call<{ ok: true }>('/api/pay/withdraw-cancel', { method: 'POST', body: JSON.stringify({ payment_id: paymentId }) });
export const completeSandboxCheckout = (ref: string, outcome: 'approve' | 'decline', last4: string) =>
  call<{ status: number; results: unknown }>('/api/pay/sandbox', { method: 'POST', body: JSON.stringify({ ref, outcome, last4 }) });

export interface PaymentRow {
  id: string;
  direction: 'deposit' | 'withdrawal';
  amount: number;
  status: string;
  methodId: string | null;
  failureReason: string | null;
  createdAt: number;
}
export interface PaymentMethodRow {
  id: string;
  kind: string;
  label: string;
  status: string;
}

/** The player's payment history and saved methods (RLS: own rows, safe columns only). */
export async function fetchPayments(): Promise<{ payments: PaymentRow[]; methods: PaymentMethodRow[] }> {
  const [p, m] = await Promise.all([
    supabase!.from('payments').select('id, direction, amount_cents, status, method_id, failure_reason, created_at').order('created_at', { ascending: false }).limit(50),
    supabase!.from('payment_methods').select('id, kind, label, status'),
  ]);
  if (p.error) throw new Error(p.error.message);
  if (m.error) throw new Error(m.error.message);
  return {
    payments: (p.data ?? []).map((r) => ({
      id: r.id,
      direction: r.direction,
      amount: Number(r.amount_cents) / 100,
      status: r.status,
      methodId: r.method_id,
      failureReason: r.failure_reason,
      createdAt: Date.parse(r.created_at),
    })),
    methods: (m.data ?? []) as PaymentMethodRow[],
  };
}

// ---------- responsible gaming (phase 5) ----------
export type LimitKind = 'deposit' | 'stake' | 'loss';
export type LimitPeriod = 'day' | 'week' | 'month';
export interface RgLimit {
  kind: LimitKind;
  period: LimitPeriod;
  window: string;
  current_cents: number | null;
  used_cents: number;
  pending: { amount_cents: number | null; effective_at: string } | null;
}
export interface RgState {
  limits: RgLimit[];
  exclusion: { until: string; kind: 'cool_off' | 'self_exclusion' } | null;
  summary: { period: 'day' | 'week' | 'month' | 'all'; deposits_cents: number; withdrawals_cents: number; staked_cents: number; returned_cents: number }[];
}
export const getRg = () => call<RgState>('/api/rm/rg');
export const setLimit = (kind: LimitKind, period: LimitPeriod, amountCents: number | null) =>
  call<{ ok: true; immediate: boolean; message: string }>('/api/rm/rg', {
    method: 'POST',
    body: JSON.stringify({ action: 'setLimit', kind, period, amount_cents: amountCents }),
  });
export const exclude = (kind: 'cool_off' | 'self_exclusion', days: number | null) =>
  call<{ ok: true; until: string }>('/api/rm/rg', { method: 'POST', body: JSON.stringify({ action: 'exclude', kind, days, confirm: true }) });

/** True while a cool-off or self-exclusion is running ('infinity' = permanent). */
export const excludedUntil = (until: string | null | undefined): Date | 'permanent' | null => {
  if (!until) return null;
  if (until === 'infinity') return 'permanent';
  const d = new Date(until);
  return d.getTime() > Date.now() ? d : null;
};
