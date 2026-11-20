import { useEffect } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useStore } from './store';
import { money } from './lib/format';
import { useTheme } from './lib/device';
import { Icon, type IconName } from './components/Icon';
import { Board } from './pages/Board';
import { Home } from './pages/Home';
import { Lineups } from './pages/Lineups';
import { HowToPlay } from './pages/HowToPlay';
import { Account } from './pages/Account';
import { Admin } from './pages/Admin';
import { Login } from './pages/Login';
import { SandboxCheckout } from './pages/SandboxCheckout';
import { ResponsibleGaming } from './pages/ResponsibleGaming';
import { ExclusionBanner, RealityCheck } from './components/RealityCheck';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/board', label: 'Board', icon: 'board' },
  { to: '/lineups', label: 'Lineups', icon: 'ticket' },
  { to: '/how-to-play', label: 'Rules', icon: 'info' },
  { to: '/account', label: 'Account', icon: 'user' },
];

function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} aria-hidden className="mark">
      <rect width="512" height="512" rx="112" fill="var(--ink)" />
      <path d="M156 236 256 136l100 100" fill="none" stroke="var(--volt)" strokeWidth="56" strokeLinecap="square" />
      <path d="M156 296l100 100 100-100" fill="none" stroke="var(--bg)" strokeWidth="56" strokeLinecap="square" />
    </svg>
  );
}

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="PicksArena home">
      <Mark />
      <span className="wordmark">
        Picks<span>Arena</span>
      </span>
    </Link>
  );
}

function OpenBadge() {
  const { entries } = useStore();
  const n = entries.filter((e) => e.status === 'open').length;
  return n > 0 ? <span className="nav-badge">{n}</span> : null;
}

/** Desktop / tablet-landscape sidebar */
function Sidebar() {
  const { balance, realMoney, session } = useStore();
  return (
    <aside className="sidebar">
      <Brand />
      <nav className="side-nav" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            <Icon name={n.icon} size={20} />
            <span>{n.label}</span>
            {n.to === '/lineups' && <OpenBadge />}
          </NavLink>
        ))}
      </nav>
      {realMoney && !session ? (
        <Link to="/login" className="side-wallet">
          <span className="eyebrow">Real-money play</span>
          <strong>Sign in</strong>
          <span className="add">or create an account</span>
        </Link>
      ) : (
        <Link to="/account" className="side-wallet">
          <span className="eyebrow">Balance</span>
          <strong>{money(balance)}</strong>
          <span className="add">
            <Icon name="plus" size={14} strokeWidth={3} /> {realMoney ? 'Wallet' : 'Add credits'}
          </span>
        </Link>
      )}
    </aside>
  );
}

/** Mobile top app bar */
function AppBar() {
  const { balance, realMoney, session } = useStore();
  return (
    <header className="appbar">
      <Brand />
      {realMoney && !session ? (
        <Link to="/login" className="balance-pill signin-pill">
          <span>Sign in</span>
        </Link>
      ) : (
      <Link to="/account" className="balance-pill" aria-label={`Balance ${money(balance)}, open account`}>
        <span>{money(balance)}</span>
        <span className="plus">
          <Icon name="plus" size={12} strokeWidth={3.5} />
        </span>
      </Link>
      )}
    </header>
  );
}

/** Mobile bottom tab bar */
function TabBar() {
  return (
    <nav className="tabbar" aria-label="Main">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end}>
          <span className="tab-ico">
            <Icon name={n.icon} size={22} />
            {n.to === '/lineups' && <OpenBadge />}
          </span>
          <span>{n.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export default function App() {
  const { toast } = useStore();
  const { pathname } = useLocation();
  useTheme();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="shell">
      <Sidebar />
      <AppBar />
      <main className="content" key={pathname}>
        <ExclusionBanner />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/board" element={<Board />} />
          <Route path="/lineups" element={<Lineups />} />
          <Route path="/how-to-play" element={<HowToPlay />} />
          <Route path="/account" element={<Account />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/login" element={<Login />} />
          <Route path="/pay/sandbox" element={<SandboxCheckout />} />
          <Route path="/responsible-gaming" element={<ResponsibleGaming />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      <TabBar />
      <RealityCheck />
      {toast && (
        <div className="toast" role="status" key={toast}>
          {toast}
        </div>
      )}
    </div>
  );
}
