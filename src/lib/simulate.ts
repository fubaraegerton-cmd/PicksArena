import type { Entry } from '../types';
import { statSpread } from '../data/generate';
import { normal } from './random';
import { payoutMultiplier } from './payouts';

/** Settle an open entry by simulating a final stat for every pick. */
export function settleEntry(entry: Entry, rand: () => number = Math.random): Entry {
  const picks = entry.picks.map((p) => {
    const pr = p.projection;
    const spread = statSpread(pr.player.sport, pr.player.position, pr.statType);
    const actual = Math.max(0, Math.round(pr.line + normal(rand) * spread));
    const over = actual > pr.line;
    const hit = p.direction === 'more' ? over : !over;
    return { ...p, actual, result: hit ? ('hit' as const) : ('miss' as const) };
  });
  const hits = picks.filter((p) => p.result === 'hit').length;
  const mult = payoutMultiplier(entry.playType, picks.length, hits);
  const payout = Math.round(entry.amount * mult * 100) / 100;
  return { ...entry, picks, payout, status: payout > 0 ? 'won' : 'lost' };
}
