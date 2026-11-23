import { useMemo, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { SPORTS } from '../data/sports';
import { PLAY_SPORTS, REAL_MONEY } from '../lib/supabase';
import { entryMultiplier } from '../lib/payouts';
import { money } from '../lib/format';
import type { Direction, Projection } from '../types';
import { ProjectionCard, Jersey } from '../components/ProjectionCard';
import { Icon } from '../components/Icon';
import { POWER_TABLE, FLEX_TABLE, MAX_PICKS, maxMultiplier } from '../lib/payouts';
import { countdown, gameTime } from '../lib/format';
import { haptic, useInstallPrompt } from '../lib/device';

/** Featured line: earliest upcoming house special, else the soonest "hot" line, else the soonest line. */
function pickFeatured(board: Projection[], now: number): Projection | undefined {
  const upcoming = board.filter((p) => p.game.startsAt > now).sort((a, b) => a.game.startsAt - b.game.startsAt);
  return upcoming.find((p) => p.special) ?? upcoming.find((p) => p.tag === 'hot') ?? upcoming[0];
}

function Hero({ p }: { p: Projection }) {
  const { picks, togglePick, now } = useStore();
  const chosen = picks.find((x) => x.projectionId === p.id)?.direction;
  const isHome = p.game.home.abbr === p.player.team.abbr;
  const soon = countdown(p.game.startsAt, now);
  const call = (d: Direction) => {
    haptic(10);
    togglePick(p.id, d);
  };

  return (
    <div className="hero-pick" style={{ '--team': p.player.team.color } as CSSProperties}>
      <p className="hero-kicker">{p.special ? 'Tonight’s house special' : 'Tonight’s featured line'}</p>
      <div className="hero-player">
        <Jersey color={p.player.team.color} number={p.player.number} />
        <div>
          <h2 className="hero-name">{p.player.name}</h2>
          <p className="hero-sub">
            {p.player.team.name}, {p.player.position}. {isHome ? 'Hosts' : 'At'} {p.opponent.abbr}{' '}
            {soon && soon !== 'Started' ? `in ${soon}` : gameTime(p.game.startsAt, now).replace('Tmrw', 'tomorrow').replace('Today', 'today')}.
          </p>
        </div>
      </div>

      <div className="hero-line" aria-label={`${p.line} ${p.statType}`}>
        <span className="hero-num">{p.line}</span>
        <span className="hero-stat">{p.statType}</span>
      </div>

      {p.note && <p className="hero-note">“{p.note}”</p>}

      <div className="hero-call" role="group" aria-label="Make your call">
        <button type="button" className={`hc less ${chosen === 'less' ? 'on' : ''}`} aria-pressed={chosen === 'less'} onClick={() => call('less')}>
          <Icon name="down" size={22} strokeWidth={3} />
          <span>
            Less <small>than {p.line}</small>
          </span>
        </button>
        <button type="button" className={`hc more ${chosen === 'more' ? 'on' : ''}`} aria-pressed={chosen === 'more'} onClick={() => call('more')}>
          <Icon name="up" size={22} strokeWidth={3} />
          <span>
            More <small>than {p.line}</small>
          </span>
        </button>
      </div>

      <p className="hero-after" aria-live="polite">
        {chosen ? (
          <>
            {picks.length === 1 ? 'On your ticket. Add one more player to play.' : `${picks.length} picks on your ticket.`}{' '}
            <Link to="/board">Finish your ticket</Link>
          </>
        ) : (
          <>Pick 2 to {MAX_PICKS} players. Get them all right to win up to {maxMultiplier('power', MAX_PICKS)}×.</>
        )}
      </p>
    </div>
  );
}


/** Lines for the phone preview: the featured line plus two more from other teams in the same sport. */
function previewLines(board: Projection[], featured: Projection | undefined, now: number): Projection[] {
  if (!featured) return [];
  const out = [featured];
  for (const p of board) {
    if (out.length === 3) break;
    if (p.game.startsAt <= now || p.tier || p.player.sport !== featured.player.sport) continue;
    if (out.some((x) => x.player.team.abbr === p.player.team.abbr || x.player.id === p.player.id)) continue;
    out.push(p);
  }
  return out;
}

/** A drawn phone showing the real board: the product, not a stock picture. */
function PhonePreview({ lines }: { lines: Projection[] }) {
  if (lines.length < 2) return null;
  const calls: Direction[] = ['more', 'less', 'more'];
  const mult = entryMultiplier(lines);
  const label = `Preview of the app: a ${lines.length}-pick ticket paying ${mult} times the entry`;
  return (
    <div className="phone" role="img" aria-label={label}>
      <div className="phone-screen" aria-hidden>
        <div className="ph-status">
          <span>9:41</span>
          <span className="ph-island" />
          <span className="ph-bal">{money(100)}</span>
        </div>
        <p className="ph-title">{SPORTS.find((x) => x.id === lines[0].player.sport)?.label ?? lines[0].player.sport} board</p>
        <ul className="ph-rows">
          {lines.map((p, i) => (
            <li key={p.id} className="ph-row" style={{ '--team': p.player.team.color } as CSSProperties}>
              <div className="ph-head">
                <span>
                  <i className="pc-dot" />
                  {p.player.team.abbr} · {p.player.position}
                </span>
                <span>{p.opponent.abbr}</span>
              </div>
              <div className="ph-body">
                <strong>{p.player.name}</strong>
                <span className="ph-line">
                  <b>{p.line}</b>
                  <small>{p.statType}</small>
                </span>
              </div>
              <div className="ph-pick">
                <span className={calls[i] === 'less' ? 'on less' : ''}>Less</span>
                <span className={calls[i] === 'more' ? 'on more' : ''}>More</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="ph-ticket">
          <span className="ph-count">{lines.length}</span>
          <span className="ph-tt">
            <strong>Power Play</strong>
            <small>{mult}× if all hit</small>
          </span>
          <span className="ph-pay">{money(10 * mult)}</span>
        </div>
      </div>
    </div>
  );
}

function LandingHero({ lines }: { lines: Projection[] }) {
  const { realMoney, session } = useStore();
  const top = maxMultiplier('power', MAX_PICKS);
  const sports = PLAY_SPORTS.map((x) => x.label);
  const sportList = sports.length > 2 ? `${sports.slice(0, -1).join(', ')} and ${sports[sports.length - 1]}` : sports.join(' and ');
  const signUp = realMoney && !session;
  return (
    <section className="lp-hero" aria-labelledby="lp-title">
      <div className="lp-copy">
        <h1 id="lp-title" data-title="Home">
          More or less.
          <br />
          Call it. Win up to {top}×
        </h1>
        <p className="lp-sub">
          Pick 2 to {MAX_PICKS} players from {sportList} and say if they’ll go over or under their line. Get every call right and your entry pays up to {top} times.
        </p>
        <div className="lp-actions">
          <Link to={signUp ? '/login?next=/board' : '/board'} className="lp-btn primary">
            {signUp ? 'Create account' : 'Start picking'}
            <Icon name="arrow" size={18} strokeWidth={2} />
          </Link>
          <a href="#how" className="lp-btn">
            How it works
          </a>
        </div>
        <p className="lp-trust">
          {realMoney ? (
            <>
              <Icon name="shield" size={16} /> 21+ in the US, 18+ elsewhere. Eligible locations only.
            </>
          ) : (
            <>
              <Icon name="check" size={16} /> Free to try with $100 in play credits
            </>
          )}
        </p>
      </div>
      <div className="lp-visual">
        <PhonePreview lines={lines} />
      </div>
    </section>
  );
}

function SportStrip({ board, now }: { board: Projection[]; now: number }) {
  return (
    <nav className="sport-strip" aria-label="Sports on the board">
      {PLAY_SPORTS.map((x) => {
        const n = board.filter((p) => p.player.sport === x.id && p.game.startsAt > now).length;
        return (
          <Link key={x.id} to={`/board?sport=${x.id}`} className="ss-item">
            <strong>{x.label}</strong>
            <span>{n ? `${n} lines` : 'No games today'}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function StartingSoon({ board, now }: { board: Projection[]; now: number }) {
  const games = useMemo(() => {
    const m = new Map<string, { p: Projection; lines: number }>();
    for (const p of board) {
      if (p.game.startsAt <= now) continue;
      const cur = m.get(p.game.id);
      if (cur) cur.lines++;
      else m.set(p.game.id, { p, lines: 1 });
    }
    return [...m.values()].sort((a, b) => a.p.game.startsAt - b.p.game.startsAt).slice(0, 5);
  }, [board, now]);

  return (
    <aside className="soon-rail" aria-labelledby="soon-title">
      <h2 id="soon-title">Starting soon</h2>
      <ol>
        {games.map(({ p, lines }) => {
          const g = p.game;
          const sport = SPORTS.find((s) => s.id === g.sport);
          return (
            <li key={g.id}>
              <Link to={`/board?sport=${g.sport}`}>
                <span className="sr-teams">
                  <i style={{ background: g.away.color }} />
                  {g.away.abbr} at <i style={{ background: g.home.color }} />
                  {g.home.abbr}
                </span>
                <span className="sr-meta">
                  {sport?.label}, {countdown(g.startsAt, now) ?? gameTime(g.startsAt, now)}
                </span>
                <span className="sr-lines">{lines} lines</span>
              </Link>
            </li>
          );
        })}
      </ol>
      <Link to="/board" className="sr-all">
        See the full board
      </Link>
    </aside>
  );
}

function PayoutLadder() {
  const max = Math.max(...Object.values(POWER_TABLE));
  return (
    <figure className="ladder" aria-labelledby="ladder-cap">
      <figcaption id="ladder-cap">
        <strong>Power Play pays more with every pick</strong>
        <span>Multiplier on your entry when every pick hits</span>
      </figcaption>
      <ul>
        {Object.entries(POWER_TABLE).map(([n, m]) => (
          <li key={n}>
            <span className="lad-n">{n} picks</span>
            <span className="lad-bar">
              <i style={{ width: `${Math.max(6, (m / max) * 100)}%` }} />
            </span>
            <span className="lad-m">{m}×</span>
          </li>
        ))}
      </ul>
      {!REAL_MONEY && (
      <p className="ladder-flex">
        Flex Play pays less but forgives a miss: a 5-pick Flex pays {FLEX_TABLE[5][5]}× for 5 of 5 and {FLEX_TABLE[5][4]}× for 4 of 5.
      </p>
      )}
      {REAL_MONEY && <p className="ladder-flex">If a player lands exactly on the line, that pick drops out and your entry pays on the picks that remain.</p>}
    </figure>
  );
}

const FAQ = REAL_MONEY ? [
  {
    q: 'Who can play?',
    a: 'Adults of legal age who live in an eligible state. We check your date of birth when you sign up and again before every entry, and we verify your identity before your first withdrawal.',
  },
  {
    q: 'What does More or Less mean?',
    a: 'Each player has a line, like 24.5 points. Pick More if you think they’ll beat it, or Less if they’ll fall short. If a player lands exactly on a whole-number line, that pick drops out and the entry pays on the rest.',
  },
  {
    q: 'When does my entry lock and settle?',
    a: 'Each pick locks when that player’s game starts. Your entry settles automatically once every game on it is final, and winnings go straight to your wallet.',
  },
  {
    q: 'What if a game is cancelled or a player sits out?',
    a: 'Those picks are voided and your entry is re-priced on the picks that remain. If fewer than two remain, your stake is refunded in full.',
  },
] : [
  {
    q: 'Is real money involved?',
    a: 'No. Everyone starts with $100 in play credits, and you can top up from your account at any time. Nothing can be bought, cashed out or withdrawn.',
  },
  {
    q: 'What does More or Less mean?',
    a: 'Each player has a line, like 24.5 points. Pick More if you think they’ll beat it, or Less if they’ll fall short. Lines end in .5, so a pick can’t tie.',
  },
  {
    q: 'Who sets the lines?',
    a: 'Most lines are generated for each sport. The house also posts specials, marked with a star, often with a short note on why they like it.',
  },
  {
    q: 'When does my entry settle?',
    a: 'House picks settle when the house posts the official final stats. Entries made only of generated lines can be settled straight away from your Lineups page.',
  },
];

export function Home() {
  const { board, now, picks, togglePick } = useStore();
  const install = useInstallPrompt();
  const featured = useMemo(() => pickFeatured(board, now), [board, now]);
  const showcase = useMemo(() => {
    const upcoming = board.filter((p) => p.game.startsAt > now && p.id !== featured?.id);
    const specials = upcoming.filter((p) => p.special);
    return (specials.length ? specials : upcoming.filter((p) => p.tag === 'hot')).slice(0, 8);
  }, [board, now, featured]);
  const hasSpecials = showcase.some((p) => p.special);
  const selected = useMemo(() => new Map(picks.map((p) => [p.projectionId, p.direction])), [picks]);
  const preview = useMemo(() => previewLines(board, featured, now), [board, featured, now]);

  return (
    <div className="home">
      <LandingHero lines={preview} />
      <SportStrip board={board} now={now} />

      <section className="turf" aria-label="Featured line">
        {featured ? <Hero p={featured} /> : <p className="hero-empty">No games on the board right now. Check back soon.</p>}
        <StartingSoon board={board} now={now} />
      </section>

      {showcase.length > 0 && (
        <section className="home-sec" aria-labelledby="show-title">
          <div className="home-sec-head">
            <h2 id="show-title" className="home-h2">
              {hasSpecials ? 'Specials from the house' : 'Popular right now'}
            </h2>
            <Link to={hasSpecials ? '/board?sport=SPECIALS' : '/board'} className="text-btn">
              See all
            </Link>
          </div>
          <div className="scroller showcase">
            {showcase.map((p) => (
              <div key={p.id} className="showcase-item">
                <ProjectionCard projection={p} now={now} selected={selected.get(p.id)} onPick={togglePick} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="home-sec how" id="how" aria-labelledby="how-title">
        <div>
          <h2 id="how-title" className="home-h2">
            How it works
          </h2>
          <ol className="how-steps">
            <li>
              <strong>Choose 2 to {MAX_PICKS} players</strong>
              <span>From any sport, as long as they play for at least two different teams.</span>
            </li>
            <li>
              <strong>Call More or Less on each line</strong>
              <span>Change your mind any time before the game starts.</span>
            </li>
            <li>
              <strong>Pick Power or Flex, then place it</strong>
              <span>Your ticket shows exactly what each result pays before you commit.</span>
            </li>
          </ol>
          <Link to="/how-to-play" className="text-btn">
            Read the full rules
          </Link>
        </div>
        <PayoutLadder />
      </section>

      {!install.installed && (
        <section className="install-band" aria-labelledby="install-title">
          <img src="/icons/icon-192.png" alt="" width={56} height={56} />
          <div>
            <h2 id="install-title">Put PicksArena on your home screen</h2>
            <p>
              {install.canPrompt
                ? 'It opens full screen, starts instantly and keeps working offline.'
                : install.isIOS
                  ? 'In Safari, tap Share, then Add to Home Screen. It opens full screen and works offline.'
                  : 'Use your browser menu and choose Install app. It opens full screen and works offline.'}
            </p>
          </div>
          {install.canPrompt && (
            <button type="button" className="pill-btn" onClick={install.prompt}>
              Install app
            </button>
          )}
        </section>
      )}

      <section className="home-sec faq" aria-labelledby="faq-title">
        <h2 id="faq-title" className="home-h2">
          Questions
        </h2>
        {FAQ.map((f) => (
          <details key={f.q}>
            <summary>
              {f.q}
              <Icon name="plus" size={18} />
            </summary>
            <p>{f.a}</p>
          </details>
        ))}
      </section>

      {picks.length > 0 && (
        <Link to="/board" className="ticket-bar home-bar">
          <span className="tb-count">{picks.length}</span>
          <span className="tb-text">
            <strong>Finish your ticket</strong>
            <span>{picks.length === 1 ? 'Add one more player to play' : `Up to ${maxMultiplier('power', picks.length)}× on a Power Play`}</span>
          </span>
          <Icon name="arrow" size={18} strokeWidth={2.5} />
        </Link>
      )}

      <footer className="home-foot">
        <p>
          {REAL_MONEY
            ? 'Real-money play for adults of legal age in eligible states. Play responsibly.'
            : 'PicksArena is a free demo. Players, teams and lines are fictional, and all balances are play credits.'}
        </p>
        <nav aria-label="Footer">
          <Link to="/board">Board</Link>
          <Link to="/lineups">Lineups</Link>
          <Link to="/how-to-play">Rules</Link>
          <Link to="/account">Account</Link>
          {REAL_MONEY && <Link to="/responsible-gaming">Responsible gaming</Link>}
          {REAL_MONEY && <a href="tel:18004262537">Help: 1-800-GAMBLER</a>}
        </nav>
      </footer>
    </div>
  );
}
