# PicksArena

A daily fantasy **pick'em** web app: pick 2–6 player projections, call each one **More** or **Less**, choose a Power or Flex play, and win up to 37.5x your entry.

> Demo only. Players, teams and lines are fictional and generated; balances are play-money credits stored in your browser.

## Features

- **Projection board** across NBA, NFL, MLB, NHL, Soccer and College Football, with stat-type filters, search and sorting
- **Lineup slip** with Power Play (all must hit) and Flex Play (pays on partial hits), live payout tiers and validation:
  2–6 picks, at least 2 teams, one pick per player, no started games, balance check
- **My Lineups**: open/completed entries, "Simulate results" to settle with randomized final stats, win-rate and net P/L
- **Wallet** with demo deposits and account reset
- Responsive: sticky slip on desktop, bottom sheet on mobile

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (payouts, validation, settlement, board generation)
npm run build    # type-check + production build into dist/
```

## Project layout

```
src/
  data/sports.ts      sports, teams, positions and stat definitions
  data/generate.ts    seeded board generator (stable for 6 hours)
  lib/payouts.ts      payout tables + lineup validation
  lib/simulate.ts     settles an entry by simulating final stats
  store.tsx           app state (React context, persisted to localStorage)
  components/         ProjectionCard, Slip
  pages/              Board, Lineups, HowToPlay
```

Payout tables live in `src/lib/payouts.ts`; adding a sport or stat is a matter of editing `src/data/sports.ts`.
To go live you would replace `generateBoard`/`settleEntry` with calls to a real backend and stats feed.
