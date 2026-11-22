/**
 * Admin-curated content shared between the API (server) and the app (client).
 * Pure TypeScript only — no DOM or Node APIs — so both sides can import it.
 */

export const SPORT_IDS = ['NFL', 'NBA', 'MLB', 'NHL', 'SOCCER', 'CFB'] as const;
export type AdminSport = (typeof SPORT_IDS)[number];

export interface AdminTeam {
  abbr: string;
  name: string;
  color: string;
}

export type GameStatus = 'scheduled' | 'final' | 'cancelled';

export interface AdminGame {
  id: string;
  sport: AdminSport;
  home: AdminTeam;
  away: AdminTeam;
  startsAt: number;
  status: GameStatus;
  createdAt: number;
}

export interface AdminPick {
  id: string;
  gameId: string;
  side: 'home' | 'away';
  playerName: string;
  position: string;
  number?: number;
  statType: string;
  line: number;
  /** Featured "special" pick, shown in the Specials tab */
  special: boolean;
  /** Short admin take shown on the card */
  note?: string;
  /** Hidden from players when false */
  active: boolean;
  /** Final stat entered by the admin; settles entries */
  actual?: number;
  createdAt: number;
  /** Alternate line: Venom (harder, pays more) or Shield (easier, pays less). More-only. */
  tier?: PickTier;
  /** Multiplies the entry payout: > 1 for Venom, < 1 for Shield, 1 for standard */
  payoutFactor?: number;
}

export type PickTier = 'standard' | 'venom' | 'shield';

/**
 * The automatic Venom alternate for a standard line: a harder line (about 15% higher, at least one
 * whole step so .5 lines stay .5) that pays more. The factor grows with how far the line moved:
 * 1 + 2.5 × (step / line), rounded to 0.05 and kept between 1.25 and 3.
 *   20.5 points  -> 23.5 at ×1.35      6.5 assists -> 7.5 at ×1.4      0.5 home runs -> 1.5 at ×3
 */
export function autoVenom(line: number): { line: number; payoutFactor: number } {
  const step = Math.max(1, Math.round(line * 0.15));
  const raw = 1 + (2.5 * step) / Math.max(line, 0.5);
  const payoutFactor = Math.min(3, Math.max(1.25, Math.round(raw * 20) / 20));
  return { line: Math.min(999.5, line + step), payoutFactor: Math.round(payoutFactor * 100) / 100 };
}

/** Validates a Venom/Shield factor. Returns an error message or null. */
export function tierError(tier: PickTier | undefined, factor: number | undefined): string | null {
  if (!tier || tier === 'standard') return null;
  if (typeof factor !== 'number' || !Number.isFinite(factor)) return 'Enter the payout factor.';
  if (Math.round(factor * 100) !== factor * 100) return 'Use at most two decimals for the factor.';
  if (tier === 'venom' && (factor <= 1 || factor > 5)) return 'A Venom factor must be above 1 and at most 5 (e.g. 1.5).';
  if (tier === 'shield' && (factor < 0.25 || factor >= 1)) return 'A Shield factor must be from 0.25 to below 1 (e.g. 0.6).';
  return null;
}

export interface AdminData {
  version: number;
  updatedAt: number;
  games: AdminGame[];
  picks: AdminPick[];
}

export const EMPTY_DATA: AdminData = { version: 0, updatedAt: 0, games: [], picks: [] };

export type AdminAction =
  | { action: 'createGame'; game: Omit<AdminGame, 'id' | 'createdAt' | 'status'> }
  | { action: 'updateGame'; id: string; patch: Partial<Pick<AdminGame, 'status' | 'startsAt'>> }
  | { action: 'deleteGame'; id: string }
  | {
      action: 'createPick';
      pick: Omit<AdminPick, 'id' | 'createdAt' | 'actual' | 'active'> & { active?: boolean };
      /** Also post the automatic Venom alternate (standard lines only; skipped if one already exists). */
      autoVenom?: boolean;
    }
  | {
      action: 'updatePick';
      id: string;
      patch: Partial<Pick<AdminPick, 'active' | 'special' | 'note' | 'line'>> & { actual?: number | null };
    }
  | { action: 'deletePick'; id: string };

const HEX = /^#[0-9a-f]{6}$/i;

function teamError(t: AdminTeam | undefined, label: string): string | null {
  if (!t) return `${label} team is required.`;
  if (!/^[A-Z0-9]{2,4}$/.test(t.abbr ?? '')) return `${label} abbreviation must be 2–4 letters/numbers.`;
  if (!t.name || t.name.trim().length < 2 || t.name.length > 40) return `${label} team name must be 2–40 characters.`;
  if (!HEX.test(t.color ?? '')) return `${label} color must be a hex color like #1f7ae0.`;
  return null;
}

/**
 * Lines must be in half-point steps. Whole numbers (exact-line pushes) are allowed only when
 * settlement supports pushes (real money); the demo requires .5 lines so there are no ties.
 */
export function lineError(line: unknown, allowWhole = false): string | null {
  if (typeof line !== 'number' || !Number.isFinite(line)) return 'Line must be a number.';
  if (line < 0 || line > 999.5) return 'Line must be between 0 and 999.5.';
  if (allowWhole) return Math.abs(line * 2 - Math.round(line * 2)) > 1e-9 ? 'Line must be a whole number or end in .5.' : null;
  if (Math.abs((line % 1) - 0.5) > 1e-9) return 'Line must end in .5 (e.g. 24.5) so there are no ties.';
  return null;
}

/** Validates an action against the current data. Returns an error message or null. */
export function validateAction(a: AdminAction, data: AdminData, opts: { allowWholeLines?: boolean } = {}): string | null {
  switch (a.action) {
    case 'createGame': {
      const g = a.game;
      if (!g || !SPORT_IDS.includes(g.sport)) return 'Choose a sport.';
      const e = teamError(g.home, 'Home') ?? teamError(g.away, 'Away');
      if (e) return e;
      if (g.home.abbr === g.away.abbr) return 'Home and away teams must be different.';
      if (typeof g.startsAt !== 'number' || !Number.isFinite(g.startsAt)) return 'Start time is required.';
      return null;
    }
    case 'updateGame': {
      if (!data.games.some((g) => g.id === a.id)) return 'Game not found.';
      if (a.patch.status && !['scheduled', 'final', 'cancelled'].includes(a.patch.status)) return 'Invalid status.';
      if (a.patch.startsAt !== undefined && !Number.isFinite(a.patch.startsAt)) return 'Invalid start time.';
      return null;
    }
    case 'deleteGame':
      return data.games.some((g) => g.id === a.id) ? null : 'Game not found.';
    case 'createPick': {
      const p = a.pick;
      const game = data.games.find((g) => g.id === p?.gameId);
      if (!game) return 'Choose a game.';
      if (game.status !== 'scheduled') return 'Picks can only be added to scheduled games.';
      if (p.side !== 'home' && p.side !== 'away') return 'Choose the player’s team.';
      if (!p.playerName || p.playerName.trim().length < 2 || p.playerName.length > 40) return 'Player name must be 2–40 characters.';
      if (!p.position || p.position.length > 4) return 'Position is required (max 4 characters).';
      if (p.number !== undefined && (!Number.isInteger(p.number) || p.number < 0 || p.number > 99)) return 'Jersey number must be 0–99.';
      if (!p.statType || p.statType.trim().length < 2 || p.statType.length > 30) return 'Stat type must be 2–30 characters.';
      if (p.note && p.note.length > 140) return 'Note must be 140 characters or fewer.';
      const dupe = data.picks.some(
        (x) =>
          x.gameId === p.gameId &&
          x.playerName.trim().toLowerCase() === p.playerName.trim().toLowerCase() &&
          x.statType.trim().toLowerCase() === p.statType.trim().toLowerCase() &&
          (x.tier ?? 'standard') === (p.tier ?? 'standard'),
      );
      if (dupe) return 'That player already has a line of this type for this stat in this game.';
      return tierError(p.tier, p.payoutFactor) ?? lineError(p.line, opts.allowWholeLines);
    }
    case 'updatePick': {
      const pick = data.picks.find((p) => p.id === a.id);
      if (!pick) return 'Pick not found.';
      if (a.patch.line !== undefined) {
        const le = lineError(a.patch.line, opts.allowWholeLines);
        if (le) return le;
      }
      if (a.patch.actual !== undefined && a.patch.actual !== null) {
        if (typeof a.patch.actual !== 'number' || !Number.isFinite(a.patch.actual) || a.patch.actual < 0)
          return 'Final stat must be 0 or more.';
      }
      if (a.patch.note && a.patch.note.length > 140) return 'Note must be 140 characters or fewer.';
      return null;
    }
    case 'deletePick':
      return data.picks.some((p) => p.id === a.id) ? null : 'Pick not found.';
    default:
      return 'Unknown action.';
  }
}

/** Applies a validated action, returning new data (does not bump version). */
export function applyAction(a: AdminAction, data: AdminData, makeId: () => string, now: number): AdminData {
  const d: AdminData = { ...data, games: [...data.games], picks: [...data.picks] };
  switch (a.action) {
    case 'createGame':
      d.games.push({
        id: makeId(),
        sport: a.game.sport,
        home: cleanTeam(a.game.home),
        away: cleanTeam(a.game.away),
        startsAt: a.game.startsAt,
        status: 'scheduled',
        createdAt: now,
      });
      break;
    case 'updateGame':
      d.games = d.games.map((g) => (g.id === a.id ? { ...g, ...pickDefined(a.patch) } : g));
      break;
    case 'deleteGame':
      d.games = d.games.filter((g) => g.id !== a.id);
      d.picks = d.picks.filter((p) => p.gameId !== a.id);
      break;
    case 'createPick':
      d.picks.push({
        id: makeId(),
        gameId: a.pick.gameId,
        side: a.pick.side,
        playerName: a.pick.playerName.trim(),
        position: a.pick.position.trim().toUpperCase(),
        number: a.pick.number,
        statType: a.pick.statType.trim(),
        line: a.pick.line,
        special: !!a.pick.special,
        note: a.pick.note?.trim() || undefined,
        active: a.pick.active ?? true,
        tier: a.pick.tier ?? 'standard',
        payoutFactor: a.pick.tier && a.pick.tier !== 'standard' ? a.pick.payoutFactor : 1,
        createdAt: now,
      });
      if (a.autoVenom && (a.pick.tier ?? 'standard') === 'standard') {
        const std = d.picks[d.picks.length - 1];
        const exists = d.picks.some(
          (x) => x.gameId === std.gameId && x.playerName.toLowerCase() === std.playerName.toLowerCase() && x.statType.toLowerCase() === std.statType.toLowerCase() && x.tier === 'venom',
        );
        if (!exists) d.picks.push({ ...std, id: makeId(), ...autoVenom(std.line), tier: 'venom', special: false });
      }
      break;
    case 'updatePick':
      d.picks = d.picks.map((p) => {
        if (p.id !== a.id) return p;
        const next: AdminPick = { ...p, ...(pickDefined(a.patch) as Partial<AdminPick>) };
        // explicit null clears a result
        if ('actual' in a.patch && a.patch.actual === null) delete next.actual;
        if ('note' in a.patch && !a.patch.note) delete next.note;
        return next;
      });
      break;
    case 'deletePick':
      d.picks = d.picks.filter((p) => p.id !== a.id);
      break;
  }
  return d;
}

function cleanTeam(t: AdminTeam): AdminTeam {
  return { abbr: t.abbr.trim().toUpperCase(), name: t.name.trim(), color: t.color.toLowerCase() };
}

function pickDefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}
