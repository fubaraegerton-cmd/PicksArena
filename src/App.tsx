import { NavLink, Route, Routes } from 'react-router-dom';
import { useState } from 'react';
import { useStore } from './store';
import { money } from './lib/format';
import { Board } from './pages/Board';
import { Lineups } from './pages/Lineups';
import { HowToPlay } from './pages/HowToPlay';

function Header() {
  const { balance, entries, deposit, resetAccount } = useStore();
  const [menu, setMenu] = useState(false);
  const openCount = entries.filter((e) => e.status === 'open').length;
  return (
    <header className="topbar">
      <NavLink to="/" className="logo" aria-label="PicksArena home">
        <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden>
          <path d="M14 46 32 14l18 32H38l-6-11-6 11z" fill="var(--accent)" />
          <circle cx="32" cy="40" r="4" fill="var(--more)" />
        </svg>
        <span>
          Picks<b>Arena</b>
        </span>
      </NavLink>
      <nav className="nav">
        <NavLink to="/" end>
          Board
        </NavLink>
        <NavLink to="/lineups">
          My Lineups{openCount > 0 && <span className="badge">{openCount}</span>}
        </NavLink>
        <NavLink to="/how-to-play">How to play</NavLink>
      </nav>
      <div className="wallet">
        <button type="button" className="balance" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
          {money(balance)}
          <span className="plus">+</span>
        </button>
        {menu && (
          <div className="wallet-menu" onMouseLeave={() => setMenu(false)}>
            <p className="muted tiny">Demo credits</p>
            {[25, 100, 500].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  deposit(n);
                  setMenu(false);
                }}
              >
                Add ${n}
              </button>
            ))}
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (confirm('Reset balance and delete all lineups?')) resetAccount();
                setMenu(false);
              }}
            >
              Reset account
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export default function App() {
  const { toast } = useStore();
  return (
    <>
      <Header />
      <main>
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/lineups" element={<Lineups />} />
          <Route path="/how-to-play" element={<HowToPlay />} />
          <Route path="*" element={<Board />} />
        </Routes>
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
