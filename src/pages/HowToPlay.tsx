import { Link } from 'react-router-dom';
import { FLEX_TABLE, POWER_TABLE } from '../lib/payouts';

export function HowToPlay() {
  return (
    <div className="page narrow">
      <h1>How to play</h1>
      <ol className="steps">
        <li>
          <span className="step-n">1</span>
          <div>
            <h3>Pick your players</h3>
            <p className="muted">Browse projections across sports and select 2 to 6 players. Each player has a stat line, like 24.5 Points.</p>
          </div>
        </li>
        <li>
          <span className="step-n">2</span>
          <div>
            <h3>More or Less</h3>
            <p className="muted">Predict whether each player will get more or less than their projected line. Lineups need players from at least 2 teams.</p>
          </div>
        </li>
        <li>
          <span className="step-n">3</span>
          <div>
            <h3>Choose your play & enter</h3>
            <p className="muted">Power Plays pay more but every pick must hit. Flex Plays still pay out if you miss one (or two on 5–6 picks).</p>
          </div>
        </li>
      </ol>

      <h2>Payouts</h2>
      <div className="pay-tables">
        <table>
          <caption>Power Play</caption>
          <thead>
            <tr>
              <th>Picks</th>
              <th>All correct</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(POWER_TABLE).map(([n, m]) => (
              <tr key={n}>
                <td>{n}</td>
                <td>{m}x</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table>
          <caption>Flex Play</caption>
          <thead>
            <tr>
              <th>Picks</th>
              <th>Payouts</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(FLEX_TABLE).map(([n, t]) => (
              <tr key={n}>
                <td>{n}</td>
                <td>
                  {Object.entries(t)
                    .sort((a, b) => Number(b[0]) - Number(a[0]))
                    .map(([h, m]) => `${h}/${n}: ${m}x`)
                    .join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted small">
        PicksArena is a demo. Players, teams and lines are fictional and generated; all balances are play-money credits.
      </p>
      <Link to="/" className="btn primary">
        Start picking
      </Link>
    </div>
  );
}
