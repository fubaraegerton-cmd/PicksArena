import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Direction, Entry, Pick, PlayType, Projection } from './types';
import { generateBoard } from './data/generate';
import { MAX_PICKS, flexAvailable, maxMultiplier, validateLineup } from './lib/payouts';
import { fullyResulted, settleEntry } from './lib/simulate';
import { EMPTY_DATA, type AdminData } from './shared/admin';
import { adminActuals, adminProjections } from './lib/adminBoard';

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
  submit: () => Entry | null;
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

  const setAdminData = useCallback((d: AdminData) => {
    setAdminDataState((prev) => (d.version >= prev.version || d.updatedAt >= prev.updatedAt ? d : prev));
    try {
      localStorage.setItem(ADMIN_CACHE_KEY, JSON.stringify(d));
    } catch {
      /* ignore */
    }
  }, []);

  // Fetch admin games/picks on load, every minute, and when the app comes back to the foreground
  useEffect(() => {
    let alive = true;
    const fetchAdmin = async () => {
      try {
        const res = await fetch('/api/board', { cache: 'no-store' });
        if (!res.ok) return;
        const d = (await res.json()) as AdminData;
        if (alive && Array.isArray(d.games)) setAdminData(d);
      } catch {
        /* offline — keep cached data */
      }
    };
    fetchAdmin();
    const id = setInterval(fetchAdmin, 60_000);
    const onVis = () => document.visibilityState === 'visible' && fetchAdmin();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [setAdminData]);

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

  const generated = useMemo(
    () => generateBoard(`board-${state.boardAnchor}`, state.boardAnchor),
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

  // Flex isn't valid for 2-pick lineups; fall back to power automatically
  const effectivePlayType: PlayType =
    state.playType === 'flex' && !flexAvailable(state.picks.length) ? 'power' : state.playType;

  const submit = useCallback((): Entry | null => {
    const v = validateLineup(state.picks, byId, effectivePlayType, state.amount, state.balance, Date.now());
    if (!v.ok) {
      setToast(v.errors[0]);
      return null;
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
      potentialPayout: Math.round(state.amount * maxMultiplier(effectivePlayType, n) * 100) / 100,
    };
    setState((s) => ({
      ...s,
      balance: Math.round((s.balance - entry.amount) * 100) / 100,
      entries: [entry, ...s.entries],
      picks: [],
    }));
    setToast('Entry placed. Good luck.');
    return entry;
  }, [state.picks, state.amount, state.balance, byId, effectivePlayType]);

  const canSettle = useCallback(
    (e: Entry) => e.picks.every((p) => p.projection.source !== 'admin' || actuals.has(p.projection.id)),
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
    const ready = state.entries.filter((e) => e.status === 'open' && fullyResulted(e, actuals));
    if (ready.length === 0) return;
    const ids = new Set(ready.map((e) => e.id));
    settleWhere((e) => ids.has(e.id));
    setToast(ready.length === 1 ? 'An entry was settled with official results' : `${ready.length} entries settled with official results`);
  }, [actuals, state.entries, settleWhere]);

  const settle = useCallback((id: string) => settleWhere((e) => e.id === id), [settleWhere]);
  const settleAll = useCallback(() => settleWhere(() => true), [settleWhere]);

  const deposit = useCallback((n: number) => {
    setState((s) => ({ ...s, balance: Math.round((s.balance + n) * 100) / 100 }));
    setToast(`Added $${n} in demo credits`);
  }, []);

  const resetAccount = useCallback(() => {
    setState((s) => ({ ...s, balance: STARTING_BALANCE, entries: [], picks: [] }));
    setToast('Account reset');
  }, []);

  const value: Store = {
    now,
    board,
    byId,
    balance: state.balance,
    entries: state.entries,
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
