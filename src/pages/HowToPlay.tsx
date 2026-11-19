import { Link } from 'react-router-dom';
import { FLEX_TABLE, POWER_TABLE } from '../lib/payouts';
import { REAL_MONEY } from '../lib/supabase';
import { Icon } from '../components/Icon';

const STEPS = [
  { t: 'Pick 2–6 players', d: 'Every player has a projected stat line, like 24.5 points. Mix sports if you like. Lineups need players from at least two teams.' },
  { t: 'Call More or Less', d: 'Decide whether each player beats the line or falls short. Lines end in .5, so there are no ties.' },
  REAL_MONEY
    ? { t: 'Set your stake and place it', d: 'Every pick has to hit. Each pick locks when its game starts, and your entry settles automatically when every game is final. If a player lands exactly on the line or sits out, that pick drops out and the entry pays on the rest; if fewer than two remain, your stake is refunded.' }
    : { t: 'Choose Power or Flex', d: 'Power pays the most, but every pick has to hit. Flex still pays out when you miss one (or two on 5 and 6 picks).' },
];

export function HowToPlay() {
  return (
    <div className="page narrow">
      <header className="page-head">
        <p className="eyebrow">The rules</p>
        <h1>How it works</h1>
      </header>

      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.t}>
            <span className="step-n">{String(i + 1).padStart(2, '0')}</span>
            <div>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </div>
          </li>
        ))}
      </ol>

      <h2 className="section-title">Payouts</h2>
      <div className="paygrid">
        <section className="paycard">
          <header>
            <h3>Power</h3>
            <p>All picks must hit</p>
          </header>
          <dl>
            {Object.entries(POWER_TABLE).map(([n, m]) => (
              <div key={n}>
                <dt>{n} picks</dt>
                <dd>{m}×</dd>
              </div>
            ))}
          </dl>
        </section>
        {!REAL_MONEY && (
        <section className="paycard">
          <header>
            <h3>Flex</h3>
            <p>Room for a miss</p>
          </header>
          <dl>
            {Object.entries(FLEX_TABLE).map(([n, t]) => (
              <div key={n}>
                <dt>{n} picks</dt>
                <dd className="flexpay">
                  {Object.entries(t)
                    .sort((a, b) => Number(b[0]) - Number(a[0]))
                    .map(([h, m]) => (
                      <span key={h}>
                        <small>{h}/{n}</small> {m}×
                      </span>
                    ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        )}
      </div>

      <p className="fine left">
        {REAL_MONEY
          ? 'Real money. You must be of legal age and located in an eligible state. Play responsibly.'
          : 'PicksArena is a demo. Players, teams and lines are fictional and generated. Balances are play-money credits.'}
      </p>
      <Link to="/board" className="cta inline">
        <span>Go to the board</span>
        <Icon name="arrow" size={18} />
      </Link>
    </div>
  );
}
