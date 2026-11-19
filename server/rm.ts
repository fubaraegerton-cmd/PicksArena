import { randomUUID } from 'node:crypto';
import { ageOn, db, minimumAge, playerFrom, supabaseConfigured } from './supabase.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '),
);

async function requirePlayer(req: Request) {
  if (!supabaseConfigured()) return { error: json({ error: 'Real-money play isn’t switched on.' }, 503) };
  const user = await playerFrom(req);
  if (!user) return { error: json({ error: 'Sign in to continue.' }, 401) };
  return { user };
}

interface ProfileRow {
  id: string;
  dob: string | null;
  state: string | null;
  kyc_status: string;
  self_exclusion_until: string | null;
}

async function loadProfile(id: string): Promise<ProfileRow | null> {
  const { data, error } = await db().from('profiles').select('id, dob, state, kyc_status, self_exclusion_until').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data as ProfileRow | null;
}

/** GET /api/rm/profile — the signed-in player's profile (null until they finish sign-up). */
export async function profileGET(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  return json({ profile: await loadProfile(r.user.id), minimumAge: minimumAge(null) });
}

/** POST /api/rm/profile {dob: 'YYYY-MM-DD', state: 'NJ'} — completes sign-up. Age is checked here, not in the browser. */
export async function profilePOST(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  let body: { dob?: string; state?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  const dob = String(body.dob ?? '');
  const state = String(body.state ?? '').toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob))) return json({ error: 'Enter your date of birth.' }, 422);
  if (!US_STATES.has(state)) return json({ error: 'Choose the state you live in.' }, 422);
  const age = ageOn(dob);
  if (age > 120) return json({ error: 'Check your date of birth.' }, 422);
  const min = minimumAge(state);
  if (age < min) return json({ error: `You must be ${min} or older to play.` }, 403);

  const existing = await loadProfile(r.user.id);
  if (existing?.dob && existing.dob !== dob)
    return json({ error: 'Your date of birth is already on file. Contact support to correct it.' }, 409);
  const { error } = await db().from('profiles').upsert({ id: r.user.id, dob, state });
  if (error) return json({ error: error.message }, 500);
  return json({ profile: await loadProfile(r.user.id) });
}

const ENTRY_ERRORS: [RegExp, number, string][] = [
  [/insufficient_funds/, 402, 'Not enough funds in your wallet for this entry.'],
  [/game_started/, 409, 'A game on your ticket has already started. Remove that pick to continue.'],
  [/projection_unavailable|projection_not_found/, 409, 'A line on your ticket is no longer available. Remove it to continue.'],
  [/one_pick_per_player/, 422, 'Only one pick per player is allowed.'],
  [/needs_two_teams/, 422, 'Your picks must include players from at least 2 different teams.'],
  [/duplicate_projection/, 422, 'Your ticket has the same line twice.'],
  [/pick_count_out_of_range/, 422, 'Choose 2 to 6 picks.'],
  [/stake_below_minimum/, 422, 'The minimum entry is $1.'],
  [/stake_above_maximum/, 422, 'The maximum entry is $1,000.'],
  [/self_excluded/, 403, 'Your account is self-excluded, so new entries are blocked.'],
];

/** POST /api/rm/entries {picks: [{projection_id, direction}], stake_cents, idempotency_key} */
export async function entriesPOST(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  let body: { picks?: { projection_id: string; direction: string }[]; stake_cents?: number; idempotency_key?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  const picks = Array.isArray(body.picks) ? body.picks : [];
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!picks.length || picks.some((p) => !uuid.test(p?.projection_id ?? '') || !['more', 'less'].includes(p?.direction)))
    return json({ error: 'Your ticket couldn’t be read. Remove your picks and try again.' }, 422);
  const stake = Number(body.stake_cents);
  if (!Number.isInteger(stake)) return json({ error: 'Enter a whole number of cents.' }, 422);

  // Age gate is re-checked on every entry, not only at sign-up.
  const profile = await loadProfile(r.user.id);
  if (!profile?.dob || !profile.state) return json({ error: 'Finish setting up your account first.', code: 'profile_required' }, 403);
  const min = minimumAge(profile.state);
  if (ageOn(profile.dob) < min) return json({ error: `You must be ${min} or older to play.` }, 403);

  const key = typeof body.idempotency_key === 'string' && body.idempotency_key.length >= 8 ? body.idempotency_key : `ent:${randomUUID()}`;
  const { data, error } = await db().rpc('place_entry', {
    p_user: r.user.id,
    p_picks: picks.map((p) => ({ projection_id: p.projection_id, direction: p.direction })),
    p_stake_cents: stake,
    p_key: `${r.user.id}:${key}`,
  });
  if (error) {
    const hit = ENTRY_ERRORS.find(([re]) => re.test(error.message));
    if (hit) return json({ error: hit[2] }, hit[1]);
    return json({ error: 'The entry couldn’t be placed. Try again.' }, 500);
  }
  return json({ entry: data });
}
