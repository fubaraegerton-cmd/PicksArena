import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { SPORTS, sportById } from '../data/sports';
import type { AdminAction, AdminData, AdminGame, AdminPick, AdminSport, AdminTeam } from '../shared/admin';
import { EMPTY_DATA, lineError } from '../shared/admin';
import { AdminError, adminDo, adminLogin, rememberPassword, savedPassword } from '../lib/adminApi';
import { gameTime } from '../lib/format';
import { Icon } from '../components/Icon';

type Tab = 'overview' | 'games' | 'picks';
type Phase = 'live' | 'upcoming' | 'final' | 'cancelled';

const phaseOf = (g: AdminGame, now: number): Phase =>
  g.status === 'final' ? 'final' : g.status === 'cancelled' ? 'cancelled' : g.startsAt <= now ? 'live' : 'upcoming';

const PHASE_LABEL: Record<Phase, string> = { live: 'In progress', upcoming: 'Upcoming', final: 'Final', cancelled: 'Cancelled' };

/* ------------------------------------------------------------------ */
/* Login                                                              */
/* ------------------------------------------------------------------ */

function Login({ onDone }: { onDone: (pass: string, data: AdminData, storage: string) => void }) {
  const [pass, setPass] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await adminLogin(pass);
      rememberPassword(pass);
      onDone(pass, r.data, r.storage);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <header className="page-head">
        <p className="eyebrow">Restricted</p>
        <h1>Admin</h1>
      </header>
      <form className="adm-card adm-login" onSubmit={submit}>
        <div className="adm-login-ico">
          <Icon name="shield" size={22} />
        </div>
        <label className="field">
          <span>Admin password</span>
          <div className="pw">
            <input
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              required
              autoFocus
            />
            <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
              <Icon name={show ? 'eyeOff' : 'eye'} size={18} />
            </button>
          </div>
        </label>
        {err && <p className="ticket-error">{err}</p>}
        <button type="submit" className="cta" disabled={busy || !pass}>
          <span>{busy ? 'Checking…' : 'Sign in'}</span>
          <Icon name="arrow" size={18} />
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                           */
/* ------------------------------------------------------------------ */

function Overview({ data, now, go }: { data: AdminData; now: number; go: (tab: Tab, gameId?: string) => void }) {
  const { board } = useStore();
  const byPhase = useMemo(() => {
    const m: Record<Phase, AdminGame[]> = { live: [], upcoming: [], final: [], cancelled: [] };
    data.games.forEach((g) => m[phaseOf(g, now)].push(g));
    m.upcoming.sort((a, b) => a.startsAt - b.startsAt);
    return m;
  }, [data.games, now]);

  const picksBy = useMemo(() => {
    const m = new Map<string, AdminPick[]>();
    data.picks.forEach((p) => m.set(p.gameId, [...(m.get(p.gameId) ?? []), p]));
    return m;
  }, [data.picks]);

  const needsResults = useMemo(
    () =>
      data.games
        .filter((g) => g.status !== 'cancelled' && g.startsAt <= now)
        .map((g) => ({ g, missing: (picksBy.get(g.id) ?? []).filter((p) => p.active && p.actual === undefined).length }))
        .filter((x) => x.missing > 0)
        .sort((a, b) => a.g.startsAt - b.g.startsAt),
    [data.games, picksBy, now],
  );

  const liveSpecials = data.picks.filter((p) => {
    const g = data.games.find((x) => x.id === p.gameId);
    return p.special && p.active && g && g.status === 'scheduled' && g.startsAt > now;
  }).length;
  const onBoard = data.picks.filter((p) => {
    const g = data.games.find((x) => x.id === p.gameId);
    return p.active && g && g.status === 'scheduled' && g.startsAt > now;
  }).length;

  const generatedBySport = useMemo(() => {
    const m = new Map<string, number>();
    board.filter((p) => p.source !== 'admin').forEach((p) => m.set(p.player.sport, (m.get(p.player.sport) ?? 0) + 1));
    return m;
  }, [board]);

  return (
    <div className="adm-stack">
      <div className="adm-kpis">
        <button type="button" className="adm-kpi" onClick={() => go('games')}>
          <span className="eyebrow">Upcoming games</span>
          <strong>{byPhase.upcoming.length}</strong>
          <span className="sub">{byPhase.live.length} in progress</span>
        </button>
        <button type="button" className="adm-kpi" onClick={() => go('picks')}>
          <span className="eyebrow">Picks on the board</span>
          <strong>{onBoard}</strong>
          <span className="sub">{data.picks.length} created in total</span>
        </button>
        <button type="button" className="adm-kpi accent" onClick={() => go('picks')}>
          <span className="eyebrow">Live specials</span>
          <strong>{liveSpecials}</strong>
          <span className="sub">Featured in the Specials tab</span>
        </button>
        <button type="button" className={`adm-kpi ${needsResults.length ? 'warn' : ''}`} onClick={() => go('picks')}>
          <span className="eyebrow">Awaiting results</span>
          <strong>{needsResults.reduce((s, x) => s + x.missing, 0)}</strong>
          <span className="sub">{needsResults.length} game{needsResults.length === 1 ? '' : 's'} need final stats</span>
        </button>
      </div>

      <div className="adm-cols">
        <section className="adm-card">
          <header className="adm-card-head">
            <h2>Needs results</h2>
            <span className="muted">Settles players’ entries</span>
          </header>
          {needsResults.length === 0 ? (
            <p className="adm-empty">Nothing waiting. Results are up to date.</p>
          ) : (
            <ul className="adm-list">
              {needsResults.map(({ g, missing }) => (
                <li key={g.id}>
                  <Matchup g={g} />
                  <span className="muted small">{gameTime(g.startsAt, now)}</span>
                  <button type="button" className="pill-btn sm" onClick={() => go('picks', g.id)}>
                    Enter {missing} result{missing === 1 ? '' : 's'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="adm-card">
          <header className="adm-card-head">
            <h2>Up next</h2>
            <button type="button" className="text-btn" onClick={() => go('games')}>
              <Icon name="plus" size={14} strokeWidth={3} /> Add game
            </button>
          </header>
          {byPhase.upcoming.length === 0 ? (
            <p className="adm-empty">No upcoming games. Add one to start posting picks.</p>
          ) : (
            <ul className="adm-list">
              {byPhase.upcoming.slice(0, 6).map((g) => {
                const ps = picksBy.get(g.id) ?? [];
                return (
                  <li key={g.id}>
                    <Matchup g={g} />
                    <span className="muted small">{gameTime(g.startsAt, now)}</span>
                    <button type="button" className="adm-count" onClick={() => go('picks', g.id)}>
                      {ps.length} pick{ps.length === 1 ? '' : 's'}
                      {ps.some((p) => p.special) && <Icon name="star" size={12} strokeWidth={2.5} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="adm-card">
        <header className="adm-card-head">
          <h2>Games by sport</h2>
          <span className="muted">Your games · auto-generated lines</span>
        </header>
        <div className="adm-sports">
          {SPORTS.map((s) => {
            const mine = data.games.filter((g) => g.sport === s.id);
            const up = mine.filter((g) => phaseOf(g, now) === 'upcoming').length;
            return (
              <div key={s.id} className="adm-sport">
                <strong>{s.label}</strong>
                <span>
                  <b>{mine.length}</b> games{up ? ` · ${up} upcoming` : ''}
                </span>
                <span className="muted">{generatedBySport.get(s.id) ?? 0} generated lines</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Matchup({ g }: { g: AdminGame }) {
  return (
    <span className="adm-matchup">
      <span className="adm-sport-tag">{sportById(g.sport as never)?.label ?? g.sport}</span>
      <i style={{ background: g.away.color }} />
      {g.away.abbr}
      <span className="at">@</span>
      <i style={{ background: g.home.color }} />
      {g.home.abbr}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Games                                                              */
/* ------------------------------------------------------------------ */

function toLocalInput(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TeamPicker({ sport, value, onChange, label }: { sport: AdminSport; value: AdminTeam; onChange: (t: AdminTeam) => void; label: string }) {
  const presets = sportById(sport as never)?.teams ?? [];
  const preset = presets.find((t) => t.abbr === value.abbr && t.name === value.name);
  const [custom, setCustom] = useState(!preset && !!value.abbr);
  return (
    <fieldset className="team-picker">
      <legend>{label}</legend>
      <select
        value={custom ? '__custom' : preset?.abbr ?? ''}
        onChange={(e) => {
          if (e.target.value === '__custom') {
            setCustom(true);
            onChange({ abbr: '', name: '', color: '#3a7bd5' });
          } else {
            setCustom(false);
            const t = presets.find((x) => x.abbr === e.target.value);
            if (t) onChange({ ...t });
          }
        }}
        required
      >
        <option value="" disabled>
          Choose team…
        </option>
        {presets.map((t) => (
          <option key={t.abbr} value={t.abbr}>
            {t.abbr} · {t.name}
          </option>
        ))}
        <option value="__custom">Custom team…</option>
      </select>
      {custom && (
        <div className="team-custom">
          <input
            placeholder="ABC"
            value={value.abbr}
            maxLength={4}
            onChange={(e) => onChange({ ...value, abbr: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
            aria-label={`${label} abbreviation`}
            required
          />
          <input
            placeholder="Team name"
            value={value.name}
            maxLength={40}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            aria-label={`${label} name`}
            required
          />
          <input type="color" value={value.color} onChange={(e) => onChange({ ...value, color: e.target.value })} aria-label={`${label} color`} />
        </div>
      )}
    </fieldset>
  );
}

const blankTeam: AdminTeam = { abbr: '', name: '', color: '#3a7bd5' };

function GameForm({ run, busy }: { run: (a: AdminAction) => Promise<boolean>; busy: boolean }) {
  const [sport, setSport] = useState<AdminSport>('NBA');
  const [away, setAway] = useState<AdminTeam>(blankTeam);
  const [home, setHome] = useState<AdminTeam>(blankTeam);
  const [when, setWhen] = useState(() => toLocalInput(Math.ceil((Date.now() + 2 * 3600_000) / 900_000) * 900_000));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run({ action: 'createGame', game: { sport, away, home, startsAt: new Date(when).getTime() } });
    if (ok) {
      setAway(blankTeam);
      setHome(blankTeam);
    }
  };

  return (
    <form className="adm-card adm-form" onSubmit={submit}>
      <header className="adm-card-head">
        <h2>Add a game</h2>
      </header>
      <div className="field" role="group" aria-labelledby="adm-sport-label">
        <span id="adm-sport-label">Sport</span>
        <div className="seg seg-sports">
          {SPORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={sport === s.id ? 'on' : ''}
              onClick={() => {
                setSport(s.id as AdminSport);
                setAway(blankTeam);
                setHome(blankTeam);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <TeamPicker key={`a-${sport}`} sport={sport} value={away} onChange={setAway} label="Away team" />
      <TeamPicker key={`h-${sport}`} sport={sport} value={home} onChange={setHome} label="Home team" />
      <label className="field">
        <span>Start time</span>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
      </label>
      <button type="submit" className="cta" disabled={busy}>
        <span>Add game</span>
        <Icon name="plus" size={18} strokeWidth={2.5} />
      </button>
    </form>
  );
}

function GamesTab({ data, now, run, busy, go }: { data: AdminData; now: number; run: (a: AdminAction) => Promise<boolean>; busy: boolean; go: (t: Tab, g?: string) => void }) {
  const [filter, setFilter] = useState<Phase | 'all'>('all');
  const games = useMemo(() => {
    const order: Record<Phase, number> = { live: 0, upcoming: 1, final: 2, cancelled: 3 };
    return [...data.games]
      .filter((g) => filter === 'all' || phaseOf(g, now) === filter)
      .sort((a, b) => order[phaseOf(a, now)] - order[phaseOf(b, now)] || a.startsAt - b.startsAt);
  }, [data.games, filter, now]);

  return (
    <div className="adm-split">
      <GameForm run={run} busy={busy} />
      <section className="adm-card">
        <header className="adm-card-head">
          <h2>Games</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Phase | 'all')} aria-label="Filter games">
            <option value="all">All</option>
            <option value="live">In progress</option>
            <option value="upcoming">Upcoming</option>
            <option value="final">Final</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </header>
        {games.length === 0 ? (
          <p className="adm-empty">No games yet.</p>
        ) : (
          <ul className="adm-rows">
            {games.map((g) => {
              const phase = phaseOf(g, now);
              const count = data.picks.filter((p) => p.gameId === g.id).length;
              return (
                <li key={g.id} className="adm-row">
                  <div className="adm-row-main">
                    <Matchup g={g} />
                    <span className="muted small">
                      {g.away.name} at {g.home.name}
                    </span>
                    <span className="small">
                      <span className={`phase ${phase}`}>{PHASE_LABEL[phase]}</span> · {gameTime(g.startsAt, now)}
                    </span>
                  </div>
                  <div className="adm-row-actions">
                    <button type="button" className="adm-count" onClick={() => go('picks', g.id)}>
                      {count} pick{count === 1 ? '' : 's'}
                    </button>
                    {g.status === 'scheduled' && phase === 'live' && (
                      <button type="button" className="pill-btn sm" disabled={busy} onClick={() => run({ action: 'updateGame', id: g.id, patch: { status: 'final' } })}>
                        Mark final
                      </button>
                    )}
                    {g.status === 'scheduled' && (
                      <button
                        type="button"
                        className="ghost-sm"
                        disabled={busy}
                        onClick={() => confirm(`Cancel ${g.away.abbr} @ ${g.home.abbr}? Its picks leave the board.`) && run({ action: 'updateGame', id: g.id, patch: { status: 'cancelled' } })}
                      >
                        Cancel
                      </button>
                    )}
                    {g.status !== 'scheduled' && (
                      <button type="button" className="ghost-sm" disabled={busy} onClick={() => run({ action: 'updateGame', id: g.id, patch: { status: 'scheduled' } })}>
                        Reopen
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label="Delete game"
                      disabled={busy}
                      onClick={() => confirm(`Delete ${g.away.abbr} @ ${g.home.abbr} and its ${count} pick(s)?`) && run({ action: 'deleteGame', id: g.id })}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Picks                                                              */
/* ------------------------------------------------------------------ */

function PickForm({ data, now, run, busy, presetGame }: { data: AdminData; now: number; run: (a: AdminAction) => Promise<boolean>; busy: boolean; presetGame: string | null }) {
  const open = data.games.filter((g) => g.status === 'scheduled' && g.startsAt > now).sort((a, b) => a.startsAt - b.startsAt);
  const [gameId, setGameId] = useState(presetGame && open.some((g) => g.id === presetGame) ? presetGame : open[0]?.id ?? '');
  const game = open.find((g) => g.id === gameId);
  const [side, setSide] = useState<'away' | 'home'>('away');
  const [playerName, setPlayerName] = useState('');
  const [position, setPosition] = useState('');
  const [number, setNumber] = useState('');
  const [statType, setStatType] = useState('');
  const [line, setLine] = useState('');
  const [special, setSpecial] = useState(true);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (presetGame && open.some((g) => g.id === presetGame)) setGameId(presetGame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetGame]);
  useEffect(() => {
    if (!game && open[0]) setGameId(open[0].id);
  }, [game, open]);

  const sportCfg = game ? sportById(game.sport as never) : undefined;
  const stats = useMemo(() => [...new Set(Object.values(sportCfg?.stats ?? {}).flat().map((s) => s.stat))], [sportCfg]);
  const lineNum = Number(line);
  const lineProblem = line === '' ? null : lineError(lineNum);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!game) return;
    const ok = await run({
      action: 'createPick',
      pick: {
        gameId: game.id,
        side,
        playerName,
        position,
        number: number === '' ? undefined : Number(number),
        statType,
        line: lineNum,
        special,
        note: note || undefined,
      },
    });
    if (ok) {
      setPlayerName('');
      setNumber('');
      setLine('');
      setNote('');
    }
  };

  if (open.length === 0)
    return (
      <section className="adm-card adm-form">
        <header className="adm-card-head">
          <h2>Add a pick</h2>
        </header>
        <p className="adm-empty">Add an upcoming game first. Picks are attached to a game.</p>
      </section>
    );

  return (
    <form className="adm-card adm-form" onSubmit={submit}>
      <header className="adm-card-head">
        <h2>Add a pick</h2>
      </header>
      <label className="field">
        <span>Game</span>
        <select value={gameId} onChange={(e) => setGameId(e.target.value)} required>
          {open.map((g) => (
            <option key={g.id} value={g.id}>
              {sportById(g.sport as never)?.label} · {g.away.abbr} @ {g.home.abbr} · {gameTime(g.startsAt, now)}
            </option>
          ))}
        </select>
      </label>
      {game && (
        <div className="field">
          <span>Player’s team</span>
          <div className="seg">
            {(['away', 'home'] as const).map((s) => (
              <button key={s} type="button" className={side === s ? 'on' : ''} onClick={() => setSide(s)}>
                <i className="swatch" style={{ background: game[s].color } as CSSProperties} />
                {game[s].abbr}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="field-row">
        <label className="field grow">
          <span>Player name</span>
          <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} maxLength={40} required placeholder="e.g. Jalen Carver" />
        </label>
        <label className="field w-sm">
          <span>Pos</span>
          <input value={position} onChange={(e) => setPosition(e.target.value.toUpperCase())} maxLength={4} required list="adm-positions" />
          <datalist id="adm-positions">
            {sportCfg?.positions.map((p) => <option key={p} value={p} />)}
          </datalist>
        </label>
        <label className="field w-sm">
          <span>#</span>
          <input type="number" min={0} max={99} value={number} onChange={(e) => setNumber(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      <div className="field-row">
        <label className="field grow">
          <span>Stat</span>
          <input value={statType} onChange={(e) => setStatType(e.target.value)} maxLength={30} required list="adm-stats" placeholder="e.g. Points" />
          <datalist id="adm-stats">
            {stats.map((s) => <option key={s} value={s} />)}
          </datalist>
        </label>
        <label className="field w-md">
          <span>Line</span>
          <input type="number" step={0.5} min={0.5} value={line} onChange={(e) => setLine(e.target.value)} required inputMode="decimal" placeholder="24.5" />
        </label>
      </div>
      {lineProblem && <p className="field-hint bad">{lineProblem}</p>}
      <label className="switch">
        <input type="checkbox" checked={special} onChange={(e) => setSpecial(e.target.checked)} />
        <span className="switch-ui" aria-hidden />
        <span>
          <strong>Special pick</strong>
          <small>Featured in the Specials tab with a star</small>
        </span>
      </label>
      <label className="field">
        <span>
          Your take <small className="muted">(optional, shown on the card)</small>
        </span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} rows={2} placeholder="e.g. Faced this defense twice, cleared 28 both times." />
        <small className="field-hint">{note.length}/140</small>
      </label>
      <button type="submit" className="cta" disabled={busy || !!lineProblem}>
        <span>Post pick</span>
        <Icon name="plus" size={18} strokeWidth={2.5} />
      </button>
    </form>
  );
}

function ResultInput({ pick, busy, run }: { pick: AdminPick; busy: boolean; run: (a: AdminAction) => Promise<boolean> }) {
  const [v, setV] = useState(pick.actual === undefined ? '' : String(pick.actual));
  useEffect(() => setV(pick.actual === undefined ? '' : String(pick.actual)), [pick.actual]);
  const dirty = v !== (pick.actual === undefined ? '' : String(pick.actual));
  return (
    <form
      className="result-input"
      onSubmit={(e) => {
        e.preventDefault();
        run({ action: 'updatePick', id: pick.id, patch: { actual: v === '' ? null : Number(v) } });
      }}
    >
      <input type="number" min={0} step="any" value={v} onChange={(e) => setV(e.target.value)} placeholder="Final" aria-label={`Final ${pick.statType} for ${pick.playerName}`} inputMode="decimal" />
      <button type="submit" className="pill-btn sm" disabled={busy || !dirty}>
        Save
      </button>
    </form>
  );
}

function PicksTab({ data, now, run, busy, gameFilter, setGameFilter }: { data: AdminData; now: number; run: (a: AdminAction) => Promise<boolean>; busy: boolean; gameFilter: string | null; setGameFilter: (g: string | null) => void }) {
  const games = new Map(data.games.map((g) => [g.id, g]));
  const [onlySpecial, setOnlySpecial] = useState(false);
  const picks = [...data.picks]
    .filter((p) => (!gameFilter || p.gameId === gameFilter) && (!onlySpecial || p.special))
    .sort((a, b) => (games.get(a.gameId)?.startsAt ?? 0) - (games.get(b.gameId)?.startsAt ?? 0) || b.createdAt - a.createdAt);

  return (
    <div className="adm-split">
      <PickForm data={data} now={now} run={run} busy={busy} presetGame={gameFilter} />
      <section className="adm-card">
        <header className="adm-card-head wrap">
          <h2>Picks</h2>
          <div className="adm-filters">
            <select value={gameFilter ?? ''} onChange={(e) => setGameFilter(e.target.value || null)} aria-label="Filter by game">
              <option value="">All games</option>
              {data.games.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.away.abbr} @ {g.home.abbr} · {gameTime(g.startsAt, now)}
                </option>
              ))}
            </select>
            <button type="button" className={`chip ${onlySpecial ? 'on' : ''}`} onClick={() => setOnlySpecial((s) => !s)}>
              <Icon name="star" size={13} strokeWidth={2.5} /> Specials
            </button>
          </div>
        </header>
        {picks.length === 0 ? (
          <p className="adm-empty">No picks yet.</p>
        ) : (
          <ul className="adm-rows">
            {picks.map((p) => {
              const g = games.get(p.gameId);
              if (!g) return null;
              const team = g[p.side];
              const started = g.startsAt <= now || g.status === 'final';
              const res = p.actual === undefined ? null : p.actual > p.line ? 'more' : 'less';
              return (
                <li key={p.id} className={`adm-row pick-row ${p.active ? '' : 'inactive'}`}>
                  <div className="adm-row-main">
                    <span className="pick-title">
                      <span className="swatch" style={{ background: team.color }} />
                      <strong>{p.playerName}</strong>
                      <span className="muted small">
                        {team.abbr} {p.position}
                        {p.number !== undefined ? ` #${p.number}` : ''}
                      </span>
                    </span>
                    <span className="pick-line">
                      <b>{p.line}</b> {p.statType}
                      <span className="muted small"> · {g.away.abbr} @ {g.home.abbr}</span>
                    </span>
                    {p.note && <span className="muted small pick-note">“{p.note}”</span>}
                    {res && (
                      <span className={`res-tag ${res}`}>
                        Final {p.actual} · {res === 'more' ? 'More' : 'Less'} wins
                      </span>
                    )}
                  </div>
                  <div className="adm-row-actions">
                    {(started || p.actual !== undefined) && g.status !== 'cancelled' && <ResultInput pick={p} busy={busy} run={run} />}
                    <button
                      type="button"
                      className={`icon-btn ${p.special ? 'starred' : ''}`}
                      aria-label={p.special ? 'Remove from specials' : 'Make special'}
                      aria-pressed={p.special}
                      disabled={busy}
                      onClick={() => run({ action: 'updatePick', id: p.id, patch: { special: !p.special } })}
                    >
                      <Icon name="star" size={17} strokeWidth={2.25} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={p.active ? 'Hide from players' : 'Show to players'}
                      aria-pressed={!p.active}
                      disabled={busy}
                      onClick={() => run({ action: 'updatePick', id: p.id, patch: { active: !p.active } })}
                    >
                      <Icon name={p.active ? 'eye' : 'eyeOff'} size={17} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label="Delete pick"
                      disabled={busy}
                      onClick={() => confirm(`Delete ${p.playerName} ${p.line} ${p.statType}?`) && run({ action: 'deletePick', id: p.id })}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

export function Admin() {
  const { now, setAdminData, notify } = useStore();
  const [pass, setPass] = useState<string | null>(savedPassword);
  const [data, setData] = useState<AdminData>(EMPTY_DATA);
  const [storage, setStorage] = useState<string>('');
  const [checking, setChecking] = useState(!!savedPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const tab = (['overview', 'games', 'picks'].includes(params.get('tab') ?? '') ? params.get('tab') : 'overview') as Tab;
  const gameFilter = params.get('game');

  const go = useCallback(
    (t: Tab, gameId?: string) => {
      const next: Record<string, string> = { tab: t };
      if (gameId) next.game = gameId;
      setParams(next);
      window.scrollTo({ top: 0 });
    },
    [setParams],
  );

  const accept = useCallback(
    (d: AdminData) => {
      setData(d);
      setAdminData(d);
    },
    [setAdminData],
  );

  // Re-validate a remembered password on load
  useEffect(() => {
    const p = savedPassword();
    if (!p) return;
    adminLogin(p)
      .then((r) => {
        accept(r.data);
        setStorage(r.storage);
      })
      .catch(() => {
        rememberPassword(null);
        setPass(null);
      })
      .finally(() => setChecking(false));
  }, [accept]);

  const run = useCallback(
    async (action: AdminAction): Promise<boolean> => {
      if (!pass) return false;
      setBusy(true);
      setError(null);
      try {
        const r = await adminDo(pass, action, data.version);
        accept(r.data);
        notify('Saved');
        return true;
      } catch (e) {
        const err = e as AdminError;
        if (err.data) accept(err.data);
        if (err.status === 401) {
          rememberPassword(null);
          setPass(null);
        }
        setError(err.message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [pass, data.version, accept, notify],
  );

  if (checking) return <div className="page"><p className="muted">Checking admin session…</p></div>;

  if (!pass)
    return (
      <Login
        onDone={(p, d, s) => {
          setPass(p);
          accept(d);
          setStorage(s);
        }}
      />
    );

  return (
    <div className="page admin">
      <header className="page-head adm-head">
        <div>
          <p className="eyebrow">
            <Icon name="shield" size={12} strokeWidth={2.5} /> Admin dashboard
          </p>
          <h1>House control</h1>
        </div>
        <div className="adm-head-actions">
          <Link to="/?sport=SPECIALS" className="ghost-sm">
            View as player
          </Link>
          <button
            type="button"
            className="ghost-sm"
            onClick={() => {
              rememberPassword(null);
              setPass(null);
            }}
          >
            <Icon name="logout" size={15} /> Sign out
          </button>
        </div>
      </header>

      {storage === 'file' && (
        <p className="adm-banner">Local development mode: data is saved to <code>.data/admin.json</code> on this machine.</p>
      )}

      <div className="seg seg-tabs adm-tabs" role="tablist">
        {(['overview', 'games', 'picks'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => go(t)}>
            {t === 'overview' ? 'Overview' : t === 'games' ? 'Games' : 'Picks'}
            <span className="cnt">{t === 'games' ? data.games.length : t === 'picks' ? data.picks.length : ''}</span>
          </button>
        ))}
      </div>

      {error && (
        <p className="ticket-error adm-error" role="alert">
          {error}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setError(null)}>
            <Icon name="close" size={14} />
          </button>
        </p>
      )}

      {tab === 'overview' && <Overview data={data} now={now} go={go} />}
      {tab === 'games' && <GamesTab data={data} now={now} run={run} busy={busy} go={go} />}
      {tab === 'picks' && (
        <PicksTab
          data={data}
          now={now}
          run={run}
          busy={busy}
          gameFilter={gameFilter}
          setGameFilter={(g) => setParams(g ? { tab: 'picks', game: g } : { tab: 'picks' })}
        />
      )}
    </div>
  );
}
