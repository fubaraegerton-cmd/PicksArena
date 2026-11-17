import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Direction, Entry, Pick, PlayType, Projection } from './types';
import { generateBoard } from './data/generate';
import { MAX_PICKS, flexAvailable, maxMultiplier, validateLineup } from './lib/payouts';
import { settleEntry } from './lib/simulate';

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
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(load);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState<string | null>(null);

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

  const board = useMemo(
    () => generateBoard(`board-${state.boardAnchor}`, state.boardAnchor),
    [state.boardAnchor],
  );
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
    setToast('Lineup submitted — good luck!');
    return entry;
  }, [state.picks, state.amount, state.balance, byId, effectivePlayType]);

  const settleWhere = useCallback((pred: (e: Entry) => boolean) => {
    setState((s) => {
      let credit = 0;
      const entries = s.entries.map((e) => {
        if (e.status !== 'open' || !pred(e)) return e;
        const settled = settleEntry(e);
        credit += settled.payout;
        return settled;
      });
      return { ...s, entries, balance: Math.round((s.balance + credit) * 100) / 100 };
    });
  }, []);

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
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore must be used inside StoreProvider');
  return s;
}
