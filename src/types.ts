export type SportId = 'NFL' | 'NBA' | 'MLB' | 'NHL' | 'SOCCER' | 'CFB';

export interface Team {
  abbr: string;
  name: string;
  color: string;
}

export interface Game {
  id: string;
  sport: SportId;
  home: Team;
  away: Team;
  startsAt: number; // epoch ms
}

export interface Player {
  id: string;
  name: string;
  position: string;
  /** Jersey number, when known */
  number?: number;
  team: Team;
  sport: SportId;
}

export interface Projection {
  id: string;
  player: Player;
  game: Game;
  opponent: Team;
  statType: string;
  line: number;
  /** Boosted lines are easier to hit but tagged as such */
  tag?: 'hot' | 'trending';
  /** Approx. percentage of entries that took "more" */
  moreShare: number;
  /** Curated by an admin (vs. generated) */
  source?: 'admin';
  /** Featured admin pick */
  special?: boolean;
  /** Admin's short take */
  note?: string;
}

export type Direction = 'more' | 'less';

export interface Pick {
  projectionId: string;
  direction: Direction;
}

export type PlayType = 'power' | 'flex';

/** push/void only occur in real-money settlement (exact-line pushes, scratched players). */
export type PickResult = 'hit' | 'miss' | 'pending' | 'push' | 'void';

export interface EntryPick {
  projection: Projection;
  direction: Direction;
  actual?: number;
  result: PickResult;
}

export interface Entry {
  id: string;
  createdAt: number;
  playType: PlayType;
  amount: number;
  picks: EntryPick[];
  status: 'open' | 'won' | 'lost' | 'refunded';
  payout: number;
  potentialPayout: number;
}
