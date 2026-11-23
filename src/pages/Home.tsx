import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { SPORTS } from '../data/sports';
import { PLAY_SPORTS, REAL_MONEY } from '../lib/supabase';
import type { Direction, Projection, SportId } from '../types';
import { Icon } from '../components/Icon';
import { FLEX_TABLE, MAX_PICKS, MIN_ENTRY, POWER_TABLE, entryMultiplier, maxMultiplier } from '../lib/payouts';
import { countdown, gameTime, money } from '../lib/format';
import { haptic, useInstallPrompt } from '../lib/device';

/* =========================================================
   Motion helpers: scroll reveals, word-by-word headlines, parallax
   ========================================================= */

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Adds .in to every [data-reveal] inside the page once it scrolls into view. */
function useReveal(root: React.RefObject<HTMLElement | null>, deps: unknown[] = []) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>('[data-reveal]:not(.in)')];
    if (reduced() || !('IntersectionObserver' in window)) {
      items.forEach((i) => i.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }),
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    );
    items.forEach((i) => io.observe(i));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Headline that rises in word by word. Pass lines; each line can be accented. */
function Split({ lines, className = '' }: { lines: { text: string; accent?: boolean; small?: boolean }[]; className?: string }) {
  let i = 0;
  return (
    <span className={`split ${className}`} data-reveal>
      {lines.map((l, li) => (
        <span key={li} className={`split-line ${l.accent ? 'accent' : ''} ${l.small ? 'small' : ''}`}>
          {l.text.split(' ').map((w, wi) => (
            <span key={wi} className="w">
              <span style={{ '--i': i++ } as CSSProperties}>{w}</span>{' '}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

/** Sets --p (0 → 1) on the element as it travels through the viewport. */
function useScrollProgress<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced()) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = Math.min(1, Math.max(0, (vh - r.top) / (vh + r.height)));
      el.style.setProperty('--p', p.toFixed(4));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  return ref;
}

/* =========================================================
   Cards
   ========================================================= */

/**
 * Tall pick card. The top is an image slot: drop a photo at /home/players/<player-id>.webp
 * and it shows; otherwise a drawn jersey in the team colour stands in.
 */
function TallCard({ p, interactive = true }: { p: Projection; interactive?: boolean }) {
  const { picks, togglePick, now } = useStore();
  const chosen = picks.find((x) => x.projectionId === p.id)?.direction;
  const tiered = !!p.tier && p.tier !== 'standard';
  const started = p.game.startsAt <= now;
  const call = (d: Direction) => {
    haptic(10);
    togglePick(p.id, d);
  };
  const isHome = p.game.home.abbr === p.player.team.abbr;
  const g = p.game;
  return (
    <article className={`tcard ${tiered ? `tier-${p.tier}` : ''} ${chosen ? 'chosen' : ''}`} style={{ '--team': p.player.team.color } as CSSProperties}>
      <div className="tc-img" style={{ backgroundImage: `url(/home/players/${p.player.id}.webp)` }}>
        <div className="tc-who">
          <strong>{p.player.name}</strong>
          <span>
            {p.player.team.name} · {p.player.position}
          </span>
        </div>
        <span className="tc-jersey" aria-hidden>
          <i>{p.player.number ?? ''}</i>
        </span>
        {tiered && <span className={`tc-flag ${p.tier}`}>{p.tier === 'venom' ? 'Venom' : 'Shield'} ×{p.payoutFactor}</span>}
        {p.special && !tiered && (
          <span className="tc-flag special">
            <Icon name="star" size={12} strokeWidth={2.5} /> Special
          </span>
        )}
      </div>
      <div className="tc-match">
        <span>
          {isHome ? `${g.away.abbr} @ ${g.home.abbr}` : `${g.away.abbr} @ ${g.home.abbr}`}
        </span>
        <span>{countdown(g.startsAt, now) ?? gameTime(g.startsAt, now)}</span>
      </div>
      <div className="tc-line">
        <b>{p.line}</b>
        <span>{p.statType}</span>
      </div>
      <div className={`tc-pick ${tiered ? 'single' : ''}`}>
        {!tiered && (
          <button type="button" disabled={!interactive || started} className={chosen === 'less' ? 'on less' : ''} aria-pressed={chosen === 'less'} onClick={() => call('less')}>
            <Icon name="down" size={16} strokeWidth={2.5} /> Less
          </button>
        )}
        <button type="button" disabled={!interactive || started} className={chosen === 'more' ? 'on more' : ''} aria-pressed={chosen === 'more'} onClick={() => call('more')}>
          <Icon name="up" size={16} strokeWidth={2.5} /> More
        </button>
      </div>
    </article>
  );
}

/** A promo-style tall card for the wall (no player). */
function PromoCard({ title, sub, cta, to, art }: { title: string; sub: string; cta: string; to: string; art: ReactNode }) {
  return (
    <article className="tcard promo">
      <div className="tc-img promo-art">{art}</div>
      <div className="tc-promo-body">
        <strong>{title}</strong>
        <span>{sub}</span>
      </div>
      <Link to={to} className="tc-cta">
        {cta}
      </Link>
    </article>
  );
}

/** Drawn phone showing the live board. */
function PhonePreview({ lines }: { lines: Projection[] }) {
  if (lines.length < 2) return <div className="phone phone-empty" aria-hidden />;
  const calls: Direction[] = ['more', 'less', 'more'];
  const mult = entryMultiplier(lines);
  return (
    <div className="phone" role="img" aria-label={`The app: a ${lines.length}-pick ticket paying ${mult} times the entry`}>
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

/* =========================================================
   Data helpers
   ========================================================= */

function upcoming(board: Projection[], now: number) {
  return board.filter((p) => p.game.startsAt > now).sort((a, b) => a.game.startsAt - b.game.startsAt);
}

/** n lines from different teams, preferring specials, then popular. */
function spread(list: Projection[], n: number, filter: (p: Projection) => boolean = () => true): Projection[] {
  const out: Projection[] = [];
  const ranked = [...list.filter((p) => p.special), ...list.filter((p) => p.tag === 'hot'), ...list];
  for (const p of ranked) {
    if (out.length >= n) break;
    if (!filter(p)) continue;
    if (out.some((x) => x.id === p.id || x.player.id === p.player.id || x.player.team.abbr === p.player.team.abbr)) continue;
    out.push(p);
  }
  return out;
}

/* =========================================================
   Sections
   ========================================================= */

function Hero({ cards }: { cards: Projection[] }) {
  const { realMoney, session } = useStore();
  const top = maxMultiplier('power', MAX_PICKS);
  const signUp = realMoney && !session;
  return (
    <section className="x-hero" aria-labelledby="x-hero-title">
      <div className="x-hero-copy">
        <p className="x-badge" data-reveal>
          <span className="burst" aria-hidden>
            New
          </span>
          Venom lines are here
        </p>
        <h1 id="x-hero-title" data-title="Home" className="x-display">
          <Split lines={[{ text: 'Call it.' }, { text: `Win up to ${top}×.`, accent: true }, { text: 'More or less on real players.', small: true }]} />
        </h1>
        <p className="x-lead" data-reveal>
          Pick 2 to {MAX_PICKS} players, call More or Less on their stat line and get every call right to win. Entries start at {money(MIN_ENTRY)}.
        </p>
        <div className="x-actions" data-reveal>
          <Link to={signUp ? '/login?next=/board' : '/board'} className="x-btn primary">
            {signUp ? 'Create account' : 'Start picking'}
          </Link>
          <a href="#how" className="x-btn ghost">
            How it works
          </a>
        </div>
      </div>
      <div className="x-hero-cards" aria-label="Tonight’s lines">
        {cards.slice(0, 3).map((p, i) => (
          <div key={p.id} className={`fan fan-${i}`}>
            <TallCard p={p} />
            <span className="x-starburst" aria-hidden>
              <b>{i === 1 ? `${top}×` : p.tier === 'venom' ? `×${p.payoutFactor}` : p.line}</b>
              <small>{i === 1 ? 'Top payout' : p.tier === 'venom' ? 'Venom' : 'Line'}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Band({ label, text, cta, to, tone = 'grad' }: { label: string; text: string; cta: string; to: string; tone?: 'grad' | 'lime' }) {
  return (
    <aside className={`x-band ${tone}`} data-reveal>
      <span className="xb-label">{label}</span>
      <strong className="xb-text">{text}</strong>
      <Link to={to} className="xb-cta">
        {cta}
      </Link>
    </aside>
  );
}

function HowToPlay() {
  const steps = [
    {
      t: `Pick 2–${MAX_PICKS} players`,
      d: 'From any sport, as long as they’re on at least two different teams.',
      art: (
        <div className="hv-stack">
          <span>Points</span>
          <span>Rebounds</span>
          <span className="on">Assists</span>
        </div>
      ),
    },
    {
      t: 'Call More or Less',
      d: 'We set the line. You say if they’ll go over or under it.',
      art: (
        <div className="hv-ml">
          <span>
            <Icon name="down" size={14} strokeWidth={2.5} /> Less
          </span>
          <span className="on">
            <Icon name="up" size={14} strokeWidth={2.5} /> More
          </span>
        </div>
      ),
    },
    {
      t: 'Choose Power or Flex',
      d: REAL_MONEY ? 'Power Play pays the most when every pick hits.' : 'Power pays the most. Flex still pays if you miss one.',
      art: (
        <div className="hv-mult">
          <b>{POWER_TABLE[4]}×</b>
          <span>4-pick Power Play</span>
        </div>
      ),
    },
    {
      t: 'Get paid',
      d: 'Entries settle on their own when the final stats are in.',
      art: (
        <div className="hv-pay">
          <span className="bal">{money(245)}</span>
          <Icon name="up" size={16} strokeWidth={2.5} />
          <span className="win">+{money(100)}</span>
        </div>
      ),
    },
  ];
  return (
    <section className="x-sec x-how4" id="how" aria-labelledby="how4-title">
      <h2 id="how4-title" className="x-display center">
        <Split lines={[{ text: 'How to play' }]} />
      </h2>
      <ol className="x-steps">
        {steps.map((s, i) => (
          <li key={s.t} data-reveal style={{ '--d': `${i * 80}ms` } as CSSProperties}>
            <div className="xs-art">{s.art}</div>
            <strong>{s.t}</strong>
            <span>{s.d}</span>
          </li>
        ))}
      </ol>
      <div className="x-actions center" data-reveal>
        <Link to="/board" className="x-btn primary">
          Start picking
        </Link>
        <Link to="/how-to-play" className="x-btn light">
          Full rules
        </Link>
      </div>
    </section>
  );
}

function Everything({ lines }: { lines: Projection[] }) {
  const sports = PLAY_SPORTS.map((s) => s.label);
  return (
    <section className="x-every" aria-labelledby="every-title">
      <div className="xe-copy">
        <h2 id="every-title" className="x-display">
          <Split lines={[{ text: 'Every stat.' }, { text: 'Every night.' }, { text: 'More or less?', accent: true }]} />
        </h2>
        <p className="x-lead" data-reveal>
          {sports.join(', ')}. Points, yards, strikeouts, shots and more.
        </p>
        <div className="x-actions" data-reveal>
          <Link to="/board" className="x-btn primary">
            Explore the board
          </Link>
        </div>
      </div>
      <div className="xe-visual" data-reveal>
        <div className="xe-photo" aria-hidden />
        <PhonePreview lines={lines} />
      </div>
    </section>
  );
}

function Popular({ board, now }: { board: Projection[]; now: number }) {
  const [sport, setSport] = useState<SportId | 'ALL'>('ALL');
  const rail = useRef<HTMLDivElement>(null);
  const list = useMemo(() => {
    const up = upcoming(board, now).filter((p) => sport === 'ALL' || p.player.sport === sport);
    return spread(up, 12);
  }, [board, now, sport]);
  const scroll = (dir: number) => rail.current?.scrollBy({ left: dir * Math.min(600, rail.current.clientWidth * 0.8), behavior: reduced() ? 'auto' : 'smooth' });
  return (
    <section className="x-sec x-popular" aria-labelledby="pop-title">
      <div className="xp-head" data-reveal>
        <h2 id="pop-title">
          <span className="live">
            Live <i />
          </span>
          Popular picks
        </h2>
        <p>Updated as lines move</p>
      </div>
      <div className="xp-pills" role="tablist" aria-label="Sport" data-reveal>
        <button type="button" role="tab" aria-selected={sport === 'ALL'} className={sport === 'ALL' ? 'on' : ''} onClick={() => setSport('ALL')}>
          <Icon name="search" size={16} /> Explore
        </button>
        {PLAY_SPORTS.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={sport === s.id} className={sport === s.id ? 'on' : ''} onClick={() => setSport(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="xp-rail" ref={rail}>
        {list.map((p) => (
          <div key={p.id} className="xp-item">
            <TallCard p={p} />
          </div>
        ))}
        {list.length === 0 && <p className="xp-empty">No open lines for this sport yet.</p>}
      </div>
      <div className="xp-arrows">
        <button type="button" aria-label="Previous" onClick={() => scroll(-1)}>
          <Icon name="arrow" size={18} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button type="button" aria-label="Next" onClick={() => scroll(1)}>
          <Icon name="arrow" size={18} />
        </button>
      </div>
      <p className="x-mono">Lines can move until each game starts. {REAL_MONEY ? 'Availability varies by location.' : 'Play credits only.'}</p>
      <div className="x-actions center">
        <Link to="/board" className="x-btn primary">
          Open the full board
        </Link>
      </div>
    </section>
  );
}

function Wall({ board, now }: { board: Projection[]; now: number }) {
  const ref = useScrollProgress<HTMLElement>();
  const cols = useMemo(() => {
    const up = upcoming(board, now);
    const venom = up.filter((p) => p.tier === 'venom');
    const picks = spread(up, 14, (p) => !p.tier);
    const v = spread(venom, 2);
    const items: ReactNode[] = picks.map((p) => <TallCard key={p.id} p={p} />);
    items.splice(
      3,
      0,
      <PromoCard
        key="venom"
        title="Venom lines"
        sub={v[0] ? `${v[0].player.name} ${v[0].line} at ×${v[0].payoutFactor}` : 'Harder line, bigger payout'}
        cta="Try Venom"
        to="/board"
        art={<span className="art-venom">V</span>}
      />,
    );
    items.splice(
      8,
      0,
      <PromoCard key="specials" title="House specials" sub="Lines the house likes tonight" cta="See specials" to="/board?sport=SPECIALS" art={<Icon name="star" size={64} strokeWidth={1.25} />} />,
    );
    const n = 6;
    const out: ReactNode[][] = Array.from({ length: n }, () => []);
    items.forEach((it, i) => out[i % n].push(it));
    return out;
  }, [board, now]);
  return (
    <section className="x-wall" ref={ref} aria-labelledby="wall-title">
      <div className="xw-head">
        <h2 id="wall-title" className="x-display center plain">
          <Split lines={[{ text: 'Run the slate' }]} />
        </h2>
        <p className="x-lead center" data-reveal>
          Tip-offs, kickoffs, first pitches. Every line on tonight’s board is one tap away.
        </p>
      </div>
      <div className="xw-cols">
        {cols.map((c, i) => (
          <div key={i} className={`xw-col c${i}`}>
            {c}
          </div>
        ))}
      </div>
    </section>
  );
}

function HowTabs({ board, now }: { board: Projection[]; now: number }) {
  const tabs = [
    {
      id: 'players',
      label: 'Players',
      icon: 'user' as const,
      body: `We set the stat line. You pick More or Less on points, yards, strikeouts and hundreds of other stats. Make at least 2 picks from different teams, up to ${MAX_PICKS}.`,
      pick: (l: Projection[]) => spread(l, 1, (p) => !p.tier)[0],
    },
    {
      id: 'venom',
      label: 'Venom & Shield',
      icon: 'bolt' as const,
      body: 'Venom lines are harder and multiply your payout. Shield lines are easier and pay a little less. Both are More only, on Power Plays.',
      pick: (l: Projection[]) => l.find((p) => p.tier === 'venom') ?? l.find((p) => p.tier),
    },
    {
      id: 'payouts',
      label: REAL_MONEY ? 'Payouts' : 'Flex',
      icon: 'ticket' as const,
      body: REAL_MONEY
        ? `Power Play pays ${POWER_TABLE[2]}× for 2 picks up to ${POWER_TABLE[6]}× for 6 when every pick hits. If a player lands exactly on a line, that pick drops out.`
        : `Flex pays even if you miss one: a 5-pick Flex pays ${FLEX_TABLE[5][5]}× for 5 of 5 and ${FLEX_TABLE[5][4]}× for 4 of 5.`,
      pick: (l: Projection[]) => spread(l, 2, (p) => !p.tier)[1],
    },
  ];
  const [tab, setTab] = useState(tabs[0].id);
  const up = useMemo(() => upcoming(board, now), [board, now]);
  const t = tabs.find((x) => x.id === tab)!;
  const p = t.pick(up);
  return (
    <section className="x-sec x-tabs" aria-labelledby="tabs-title">
      <span className="x-chip" data-reveal>
        How it works
      </span>
      <h2 id="tabs-title" className="x-display center plain">
        <Split lines={[{ text: 'Back your takes.' }, { text: 'Get paid when you’re right.' }]} />
      </h2>
      <div className="xt-tabs" role="tablist" data-reveal>
        {tabs.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} className={tab === x.id ? 'on' : ''} onClick={() => setTab(x.id)}>
            <Icon name={x.icon} size={18} /> {x.label}
          </button>
        ))}
      </div>
      <div className="xt-panel" key={tab}>
        <p>{t.body}</p>
        {p && (
          <div className="xt-card">
            <TallCard p={p} />
          </div>
        )}
      </div>
    </section>
  );
}

function Feature({ chip, lines, body, cta, to, visual, flip = false }: { chip: string; lines: { text: string; accent?: boolean }[]; body: string; cta: string; to: string; visual: ReactNode; flip?: boolean }) {
  return (
    <section className={`x-feature ${flip ? 'flip' : ''}`}>
      <div className="xf-copy">
        <span className="x-chip" data-reveal>
          {chip}
        </span>
        <h2 className="x-display">
          <Split lines={lines} />
        </h2>
        <p className="x-lead" data-reveal>
          {body}
        </p>
        <div className="x-actions" data-reveal>
          <Link to={to} className="x-btn primary">
            {cta}
          </Link>
        </div>
      </div>
      <div className="xf-visual" data-reveal>
        {visual}
      </div>
    </section>
  );
}

const FAQ = REAL_MONEY
  ? [
      { q: 'Who can play?', a: 'Adults of legal age in an eligible location: 21+ in the US and 18+ where we’re licensed elsewhere. We check your age at sign-up and your location before every entry, and verify your identity before your first withdrawal.' },
      { q: 'What does More or Less mean?', a: 'Each player has a line, like 24.5 points. Pick More if you think they’ll beat it, or Less if they’ll fall short. If a player lands exactly on a whole-number line, that pick drops out and the entry pays on the rest.' },
      { q: 'What are Venom lines?', a: 'A harder version of a line that multiplies your payout, like ×1.5. Venom picks are More only and Power Play only.' },
      { q: 'When does my entry settle?', a: 'Each pick locks when its game starts. Your entry settles on its own once every game is final, and winnings go straight to your wallet.' },
    ]
  : [
      { q: 'Is real money involved?', a: 'No. Everyone starts with $100 in play credits, and nothing can be bought, cashed out or withdrawn.' },
      { q: 'What does More or Less mean?', a: 'Each player has a line, like 24.5 points. Pick More if you think they’ll beat it, or Less if they’ll fall short.' },
      { q: 'What are Venom lines?', a: 'A harder version of a line that multiplies your payout, like ×1.5. Venom picks are More only and Power Play only.' },
      { q: 'When does my entry settle?', a: 'House picks settle when the house posts the final stats. Generated lines can be settled from your Lineups page.' },
    ];

/* =========================================================
   Page
   ========================================================= */

export function Home() {
  const { board, now, picks } = useStore();
  const install = useInstallPrompt();
  const root = useRef<HTMLDivElement>(null);
  const up = useMemo(() => upcoming(board, now), [board, now]);
  const heroCards = useMemo(() => {
    const venom = up.find((p) => p.tier === 'venom');
    const base = spread(up, 3, (p) => !p.tier);
    if (venom && base.length >= 2) return [base[0], base[1], venom];
    return base;
  }, [up]);
  const phoneLines = useMemo(() => spread(up, 3, (p) => !p.tier && p.player.sport === (up[0]?.player.sport ?? 'NBA')), [up]);
  const venomLine = useMemo(() => up.find((p) => p.tier === 'venom'), [up]);
  const shieldLine = useMemo(() => up.find((p) => p.tier === 'shield'), [up]);

  useReveal(root, [board.length]);

  // The home page is a dark stage in both themes; the app bars follow it.
  useEffect(() => {
    document.documentElement.classList.add('home-stage');
    return () => document.documentElement.classList.remove('home-stage');
  }, []);

  return (
    <div className="xhome" ref={root}>
      <p className="x-strip">
        <span>{REAL_MONEY ? 'Daily fantasy pick’em' : 'Free pick’em demo'}</span>
        <strong>{REAL_MONEY ? '21+ · Eligible locations only' : `${money(100)} in play credits`}</strong>
      </p>

      <Hero cards={heroCards} />

      <Band label="Get started" text={REAL_MONEY ? `Entries from ${money(MIN_ENTRY)}. Payouts up to ${maxMultiplier('power', MAX_PICKS)}×.` : `Start with ${money(100)} in play credits`} cta="Start picking" to="/board" />

      <HowToPlay />

      <Band label="New" text="Venom lines: harder calls, bigger payouts" cta="Try Venom" to="/board" tone="lime" />

      <Everything lines={phoneLines} />

      <Popular board={board} now={now} />

      <Wall board={board} now={now} />

      <HowTabs board={board} now={now} />

      {venomLine && (
        <Feature
          chip="Venom lines"
          lines={[{ text: 'Harder line.' }, { text: `Pays ×${venomLine.payoutFactor}.`, accent: true }]}
          body={`${venomLine.player.name} at ${venomLine.line} ${venomLine.statType.toLowerCase()} instead of the usual line. Hit it and your whole Power Play payout is multiplied.`}
          cta="Find Venom lines"
          to="/board"
          visual={
            <div className="xf-card">
              <TallCard p={venomLine} />
            </div>
          }
        />
      )}
      {shieldLine && (
        <Feature
          flip
          chip="Shield lines"
          lines={[{ text: 'Easier line.' }, { text: 'Safer play.', accent: true }]}
          body={`Want a cushion? ${shieldLine.player.name} at ${shieldLine.line} is easier to clear, and pays ×${shieldLine.payoutFactor} of the normal multiplier.`}
          cta="Find Shield lines"
          to="/board"
          visual={
            <div className="xf-card">
              <TallCard p={shieldLine} />
            </div>
          }
        />
      )}

      <section className="x-light" aria-labelledby="faq-title">
        <span className="x-chip">Questions</span>
        <h2 id="faq-title" className="xl-title">
          Everything you need to know
        </h2>
        <div className="xl-faq">
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>
                {f.q}
                <Icon name="plus" size={18} />
              </summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
        {!install.installed && (
          <div className="xl-install">
            <img src="/icons/icon-192.png" alt="" width={48} height={48} />
            <div>
              <strong>Put PicksArena on your home screen</strong>
              <span>
                {install.canPrompt
                  ? 'Opens full screen and works offline.'
                  : install.isIOS
                    ? 'In Safari, tap Share, then Add to Home Screen.'
                    : 'Use your browser menu and choose Install app.'}
              </span>
            </div>
            {install.canPrompt && (
              <button type="button" className="x-btn primary sm" onClick={install.prompt}>
                Install
              </button>
            )}
          </div>
        )}
      </section>

      <footer className="x-foot">
        <p className="x-mono">
          {REAL_MONEY
            ? 'Real-money play for adults of legal age in eligible locations. If you or someone you know has a gambling problem, call 1-800-GAMBLER.'
            : 'PicksArena is a free demo. Players, teams and lines are fictional, and all balances are play credits.'}
        </p>
        <nav aria-label="Footer">
          <Link to="/board">Board</Link>
          <Link to="/lineups">Lineups</Link>
          <Link to="/how-to-play">Rules</Link>
          <Link to="/account">Account</Link>
          {REAL_MONEY && <Link to="/responsible-gaming">Responsible gaming</Link>}
        </nav>
      </footer>

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
    </div>
  );
}
