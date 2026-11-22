import type { Pick, PlayType, Projection } from '../types';

export const MIN_PICKS = 2;
export const MAX_PICKS = 6;
export const MIN_ENTRY = 1;
export const MAX_ENTRY = 1000;

/** Power Play: every pick must hit. Multiplier by pick count. */
export const POWER_TABLE: Record<number, number> = {
  2: 3,
  3: 5,
  4: 10,
  5: 20,
  6: 40,
};

/** Flex Play: pays on a sliding scale. Keyed by pick count → correct count → multiplier. */
export const FLEX_TABLE: Record<number, Record<number, number>> = {
  3: { 3: 2.25, 2: 1.25 },
  4: { 4: 5, 3: 1.5 },
  5: { 5: 10, 4: 2, 3: 0.4 },
  6: { 6: 25, 5: 2, 4: 0.4 },
};

/** Venom/Shield lines (tier ≠ standard) are More-only and multiply the payout. */
export const isTiered = (p: Projection | undefined) => !!p && !!p.tier && p.tier !== 'standard';
export const factorOf = (p: Projection | undefined) => (p && isTiered(p) ? p.payoutFactor ?? 1 : 1);

/** Power multiplier for these legs: table × product of Venom/Shield factors (2 decimals, max 1000×). Same rule as the database. */
export function entryMultiplier(projs: Projection[]): number {
  const base = POWER_TABLE[projs.length] ?? 0;
  const factor = projs.reduce((f, p) => f * factorOf(p), 1);
  return Math.min(Math.round(base * factor * 100) / 100, 1000);
}

export function flexAvailable(n: number) {
  return n >= 3 && n <= MAX_PICKS;
}

export function maxMultiplier(playType: PlayType, n: number): number {
  if (playType === 'power') return POWER_TABLE[n] ?? 0;
  return FLEX_TABLE[n]?.[n] ?? 0;
}

export function payoutMultiplier(playType: PlayType, n: number, hits: number): number {
  if (playType === 'power') return hits === n ? POWER_TABLE[n] ?? 0 : 0;
  return FLEX_TABLE[n]?.[hits] ?? 0;
}

export function payoutTiers(playType: PlayType, n: number): { hits: number; mult: number }[] {
  if (playType === 'power') return POWER_TABLE[n] ? [{ hits: n, mult: POWER_TABLE[n] }] : [];
  const t = FLEX_TABLE[n];
  if (!t) return [];
  return Object.entries(t)
    .map(([h, m]) => ({ hits: Number(h), mult: m }))
    .sort((a, b) => b.hits - a.hits);
}

export interface Validation {
  ok: boolean;
  errors: string[];
}

export function validateLineup(
  picks: Pick[],
  byId: Map<string, Projection>,
  playType: PlayType,
  amount: number,
  balance: number,
  now = Date.now(),
): Validation {
  const errors: string[] = [];
  const projs = picks.map((p) => byId.get(p.projectionId)).filter(Boolean) as Projection[];

  if (projs.length < MIN_PICKS) errors.push(`Select at least ${MIN_PICKS} players.`);
  if (picks.some((p) => p.direction === 'less' && isTiered(byId.get(p.projectionId))))
    errors.push('Venom and Shield picks can only be More.');
  if (playType === 'flex' && projs.some(isTiered)) errors.push('Venom and Shield picks are Power Play only.');
  if (projs.length > MAX_PICKS) errors.push(`You can select at most ${MAX_PICKS} players.`);

  const teams = new Set(projs.map((p) => p.player.team.abbr));
  if (projs.length >= MIN_PICKS && teams.size < 2)
    errors.push('Your lineup must include players from at least 2 different teams.');

  const players = new Set(projs.map((p) => p.player.id));
  if (players.size !== projs.length) errors.push('Only one pick per player is allowed.');

  if (projs.some((p) => p.game.startsAt <= now)) errors.push('One or more games have already started.');

  if (playType === 'flex' && !flexAvailable(projs.length))
    errors.push('Flex Play requires 3 to 6 picks.');

  if (!Number.isFinite(amount) || amount < MIN_ENTRY) errors.push(`Minimum entry is $${MIN_ENTRY}.`);
  else if (amount > MAX_ENTRY) errors.push(`Maximum entry is $${MAX_ENTRY}.`);
  else if (amount > balance) errors.push('Insufficient balance.');

  return { ok: errors.length === 0, errors };
}
