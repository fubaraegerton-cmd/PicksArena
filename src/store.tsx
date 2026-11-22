import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Direction, Entry, Pick, PlayType, Projection } from './types';
import { generateBoard } from './data/generate';
import { MAX_PICKS, entryMultiplier, flexAvailable, isTiered, maxMultiplier, validateLineup } from './lib/payouts';
import { fullyResulted, settleEntry } from './lib/simulate';
import { EMPTY_DATA, type AdminData } from './shared/admin';
import { adminActuals, adminProjections } from './lib/adminBoard';
import { ApiError, REAL_MONEY, fetchEntries, fetchWallet, getProfile, placeEntry, supabase, type Profile, type Wallet } from './lib/supabase';

export type SubmitResult = 'ok' | 'signin' | 'profile' | 'error';
export interface Session {
  userId: string;
  email: string | null;
}

const ADMIN_CACHE_KEY = 'picksarena:admin-cache';

function loadAdminCache(): AdminData {
  try {
    const raw = localStorage.getItem(ADMIN_CACHE_KEY);
    return raw ? (JSON.parse(raw) as AdminData) : EMPTY_DATA;
  } catch {
    return EMPTY_DATA;
  }
}

const STORAGE_KEY = 'picksarena:v1';
const STARTING_BALANCE = 100;
const BOARD_TTL = 6 * 3600_000;

interface Persisted {
  balance: number;
  entries: Entry[];
  picks: Pick[];
  playType: PlayType;
  amount: number;
  boardAnchor: number;
}

function load(): Persisted {
  const fallback: Persisted = {
    balance: STARTING_BALANCE,
    entries: [],
    picks: [],
    playType: 'power',
    amount: 10,
    boardAnchor: Math.floor(Date.now() / 3600_000) * 3600_000,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = { ...fallback, ...JSON.parse(raw) } as Persisted;
    if (Date.now() - parsed.boardAnchor > BOARD_TTL) {
      parsed.boardAnchor = fallback.boardAnchor;
      parsed.picks = [];
    }
    return parsed;
  } catch {
    return fallback;
  }
}

interface Store {
  now: number;
  board: Projection[];
  byId: Map<string, Projection>;
  balance: number;
  entries: Entry[];
  picks: Pick[];
  playType: PlayType;
  amount: number;
  toast: string | null;
  togglePick: (projectionId: string, direction: Direction) => void;
  removePick: (projectionId: string) => void;
  clearPicks: () => void;
  setPlayType: (t: PlayType) => void;
  setAmount: (n: number) => void;
  /** Places the current ticket. In real-money mode this goes through the server. */
  submit: () => Promise<SubmitResult>;
  submitting: boolean;
  /** True when the app is connected to Supabase and plays for real funds. */
  realMoney: boolean;
  session: Session | null;
  /** Real-money profile (DOB/state). null until the player completes sign-up. */
  profile: Profile | null;
  accountLoaded: boolean;
  wallet: Wallet | null;
  refreshAccount: () => Promise<void>;
  /** Reload the board and (in real-money mode) the account — used by pull-to-refresh. */
  refreshAll: () => Promise<void>;
  /** False until the first board fetch has finished (for loading skeletons). */
  boardLoaded: boolean;
  signOut: () => Promise<void>;
  settle: (entryId: string) => void;
  settleAll: () => void;
  deposit: (n: number) => void;
  resetAccount: () => void;
  notify: (msg: string) => void;
  /** Admin-curated games and picks (shared across all players) */
  adminData: AdminData;
  /** Replace admin data locally, e.g. right after the admin saves a change */
  setAdminData: (d: AdminData) => void;
  /** Whether an open entry can be settled now (admin picks need official results first) */
  canSettle: (e: Entry) => boolean;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(load);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState<string | null>(null);
  const [adminData, setAdminDataState] = useState<AdminData>(loadAdminCache);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [accountLoaded, setAccountLoaded] = useState(!REAL_MONEY);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [rmEntries, setRmEntries] = useState<Entry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const ticketKey = useRef<string>(crypto.randomUUID());

  // ----- real-money account: session, profile, wallet, entries -----
  const refreshAccount = useCallback(async () => {
    if (!REAL_MONEY || !supabase) return;
    const { data } = await supabase.auth.getSession();
    const s = data.session;
    // Keep the same object while the user is unchanged, so effects keyed on it don't re-run.
    setSession((prev) => {
      if (!s) return null;
      if (prev?.userId === s.user.id && prev.email === (s.user.email ?? null)) return prev;
      return { userId: s.user.id, email: s.user.email ?? null };
    });
    if (!s) {
      setProfile(null);
      setWallet(null);
      setRmEntries([]);
      setAccountLoaded(true);
      return;
    }
    try {
      const [p, w, e] = await Promise.all([getProfile(), fetchWallet(), fetchEntries()]);
      setProfile(p.profile);
      setWallet(w);
      setRmEntries(e);
    } catch {
      /* keep last known values; the next refresh retries */
    } finally {
      setAccountLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!REAL_MONEY || !supabase) return;
    refreshAccount();
    const { data } = supabase.auth.onAuthStateChange((event) => {
      // Never call Supabase inside this callback: supabase-js holds its auth lock here and
      // awaiting another auth call deadlocks. Defer to the next tick instead.
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') setTimeout(() => refreshAccount(), 0);
    });
    const id = setInterval(() => document.visibilityState === 'visible' && refreshAccount(), 30_000);
    return () => {
      data.subscription.unsubscribe();
      clearInterval(id);
    };
  }, [refreshAccount]);

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut();
    await refreshAccount();
  }, [refreshAccount]);

  const setAdminData = useCallback((d: AdminData) => {
    setAdminDataState((prev) => (d.version >= prev.version || d.updatedAt >= prev.updatedAt ? d : prev));
    try {
      localStorage.setItem(ADMIN_CACHE_KEY, JSON.stringify(d));
    } catch {
      /* ignore */
    }
  }, []);

  const [boardLoaded, setBoardLoaded] = useState(false);
  const fetchAdmin = useCallback(async () => {
    try {
      const res = await fetch('/api/board', { cache: 'no-store' });
      if (!res.ok) return;
      const d = (await res.json()) as AdminData;
      if (Array.isArray(d.games)) setAdminData(d);
    } catch {
      /* offline — keep cached data */
    } finally {
      setBoardLoaded(true);
    }
  }, [setAdminData]);

  // Fetch admin games/picks on load, every minute, and when the app comes back to the foreground
  useEffect(() => {
    let alive = true;
    fetchAdmin();
    const id = setInterval(() => alive && fetchAdmin(), 60_000);
    const onVis = () => alive && document.visibilityState === 'visible' && fetchAdmin();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchAdmin]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable — keep running in memory */
    }
  }, [state]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  // Real-money mode shows only the house's real lines; the demo adds generated ones.
  const generated = useMemo(
    () => (REAL_MONEY ? [] : generateBoard(`board-${state.boardAnchor}`, state.boardAnchor)),
    [state.boardAnchor],
  );
  const board = useMemo(() => [...adminProjections(adminData), ...generated], [adminData, generated]);
  const actuals = useMemo(() => adminActuals(adminData), [adminData]);
  const byId = useMemo(() => new Map(board.map((p) => [p.id, p])), [board]);

  // Drop picks that no longer exist on the board
  useEffect(() => {
    if (state.picks.some((p) => !byId.has(p.projectionId))) {
      setState((s) => ({ ...s, picks: s.picks.filter((p) => byId.has(p.projectionId)) }));
    }
  }, [byId, state.picks]);

  const notify = useCallback((msg: string) => setToast(msg), []);

  const togglePick = useCallback(
    (projectionId: string, direction: Direction) => {
      const proj = byId.get(projectionId);
      if (!proj) return;
      setState((s) => {
        const existing = s.picks.find((p) => p.projectionId === projectionId);
        if (existing) {
          if (existing.direction === direction)
            return { ...s, picks: s.picks.filter((p) => p.projectionId !== projectionId) };
          return {
            ...s,
            picks: s.picks.map((p) => (p.projectionId === projectionId ? { ...p, direction } : p)),
          };
        }
        // Replace any other line for the same player
        const samePlayer = s.picks.find((p) => byId.get(p.projectionId)?.player.id === proj.player.id);
        const base = samePlayer ? s.picks.filter((p) => p !== samePlayer) : s.picks;
        if (base.length >= MAX_PICKS) {
          setToast(`Lineups are limited to ${MAX_PICKS} picks`);
          return s;
        }
        if (samePlayer) setToast(`Swapped ${proj.player.name}'s pick to ${proj.statType}`);
        return { ...s, picks: [...base, { projectionId, direction }] };
      });
    },
    [byId],
  );

  const removePick = useCallback(
    (projectionId: string) =>
      setState((s) => ({ ...s, picks: s.picks.filter((p) => p.projectionId !== projectionId) })),
    [],
  );

  const clearPicks = useCallback(() => setState((s) => ({ ...s, picks: [] })), []);
  const setPlayType = useCallback((playType: PlayType) => setState((s) => ({ ...s, playType })), []);
  const setAmount = useCallback((amount: number) => setState((s) => ({ ...s, amount })), []);

  // Flex isn't valid for 2-pick lineups (and isn't offered for real money); fall back to power
  const effectivePlayType: PlayType =
    REAL_MONEY || (state.playType === 'flex' && !flexAvailable(state.picks.length)) || state.picks.some((p) => isTiered(byId.get(p.projectionId)))
      ? 'power'
      : state.playType;

  // A new ticket (picks or stake changed) gets a new idempotency key; retries of the same ticket reuse it.
  useEffect(() => {
    ticketKey.current = crypto.randomUUID();
  }, [state.picks, state.amount]);

  const balance = REAL_MONEY ? wallet?.available ?? 0 : state.balance;

  const submit = useCallback(async (): Promise<SubmitResult> => {
    if (REAL_MONEY) {
      if (!session) return 'signin';
      if (!profile?.dob) return 'profile';
      const v = validateLineup(state.picks, byId, 'power', state.amount, balance, Date.now());
      if (!v.ok) {
        setToast(v.errors[0]);
        return 'error';
      }
      setSubmitting(true);
      try {
        await placeEntry(state.picks, Math.round(state.amount * 100), ticketKey.current);
        setState((s) => ({ ...s, picks: [] }));
        setToast('Entry placed. Good luck.');
        await refreshAccount();
        return 'ok';
      } catch (e) {
        const err = e as ApiError;
        if (err.code === 'profile_required') return 'profile';
        if (err.status === 401) return 'signin';
        setToast(err.message);
        await refreshAccount();
        return 'error';
      } finally {
        setSubmitting(false);
      }
    }
    const v = validateLineup(state.picks, byId, effectivePlayType, state.amount, state.balance, Date.now());
    if (!v.ok) {
      setToast(v.errors[0]);
      return 'error';
    }
    const n = state.picks.length;
    const entry: Entry = {
      id: `E${Date.now().toString(36).toUpperCase()}`,
      createdAt: Date.now(),
      playType: effectivePlayType,
      amount: state.amount,
      picks: state.picks.map((p) => ({
        projection: byId.get(p.projectionId)!,
        direction: p.direction,
        result: 'pending',
      })),
      status: 'open',
      payout: 0,
      potentialPayout:
        Math.round(
          state.amount *
            (effectivePlayType === 'power' ? entryMultiplier(state.picks.map((p) => byId.get(p.projectionId)!)) : maxMultiplier(effectivePlayType, n)) *
            100,
        ) / 100,
    };
    setState((s) => ({
      ...s,
      balance: Math.round((s.balance - entry.amount) * 100) / 100,
      entries: [entry, ...s.entries],
      picks: [],
    }));
    setToast('Entry placed. Good luck.');
    return 'ok';
  }, [state.picks, state.amount, state.balance, byId, effectivePlayType, session, profile, balance, refreshAccount]);

  const canSettle = useCallback(
    (e: Entry) => !REAL_MONEY && e.picks.every((p) => p.projection.source !== 'admin' || actuals.has(p.projection.id)),
    [actuals],
  );

  const settleWhere = useCallback((pred: (e: Entry) => boolean) => {
    setState((s) => {
      let credit = 0;
      const entries = s.entries.map((e) => {
        if (e.status !== 'open' || !pred(e) || !canSettle(e)) return e;
        const settled = settleEntry(e, Math.random, actuals);
        credit += settled.payout;
        return settled;
      });
      return { ...s, entries, balance: Math.round((s.balance + credit) * 100) / 100 };
    });
  }, [actuals, canSettle]);

  // Entries made only of admin picks settle automatically once the admin posts every final stat
  useEffect(() => {
    if (REAL_MONEY) return; // the server settles real entries
    const ready = state.entries.filter((e) => e.status === 'open' && fullyResulted(e, actuals));
    if (ready.length === 0) return;
    const ids = new Set(ready.map((e) => e.id));
    settleWhere((e) => ids.has(e.id));
    setToast(ready.length === 1 ? 'An entry was settled with official results' : `${ready.length} entries settled with official results`);
  }, [actuals, state.entries, settleWhere]);

  const settle = useCallback((id: string) => settleWhere((e) => e.id === id), [settleWhere]);
  const settleAll = useCallback(() => settleWhere(() => true), [settleWhere]);

  // Real-money results land on the server; pull fresh entries/wallet when the slate updates.
  const signedInId = session?.userId;
  useEffect(() => {
    if (REAL_MONEY && signedInId) refreshAccount();
  }, [adminData.version, signedInId, refreshAccount]);

  const deposit = useCallback((n: number) => {
    if (REAL_MONEY) return;
    setState((s) => ({ ...s, balance: Math.round((s.balance + n) * 100) / 100 }));
    setToast(`Added $${n} in demo credits`);
  }, []);

  const resetAccount = useCallback(() => {
    if (REAL_MONEY) return;
    setState((s) => ({ ...s, balance: STARTING_BALANCE, entries: [], picks: [] }));
    setToast('Account reset');
  }, []);

  const value: Store = {
    now,
    board,
    byId,
    balance,
    entries: REAL_MONEY ? rmEntries : state.entries,
    picks: state.picks,
    playType: effectivePlayType,
    amount: state.amount,
    toast,
    togglePick,
    removePick,
    clearPicks,
    setPlayType,
    setAmount,
    submit,
    submitting,
    realMoney: REAL_MONEY,
    session,
    profile,
    accountLoaded,
    wallet,
    refreshAccount,
    refreshAll: async () => {
      await Promise.all([fetchAdmin(), refreshAccount()]);
    },
    boardLoaded,
    signOut,
    settle,
    settleAll,
    deposit,
    resetAccount,
    notify,
    adminData,
    setAdminData,
    canSettle,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore must be used inside StoreProvider');
  return s;
}
