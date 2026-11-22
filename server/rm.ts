import { randomUUID } from 'node:crypto';
import { ageOn, db, limitMessage, playerFrom, rateLimit, supabaseConfigured } from './supabase.js';
import { GEO_MESSAGES, checkLocation, deviceHash } from './geo.js';
import { applyDecision, kycProvider, latestKyc } from './kyc.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '),
);

export async function requirePlayer(req: Request) {
  if (!supabaseConfigured()) return { error: json({ error: 'Real-money play isn’t switched on.' }, 503) };
  const user = await playerFrom(req);
  if (!user) return { error: json({ error: 'Sign in to continue.' }, 401) };
  return { user };
}

interface ProfileRow {
  id: string;
  dob: string | null;
  state: string | null;
  country: string;
  kyc_status: string;
  self_exclusion_until: string | null;
  flags: Record<string, unknown>;
}

export async function loadProfile(id: string): Promise<ProfileRow | null> {
  const { data, error } = await db()
    .from('profiles')
    .select('id, dob, state, country, kyc_status, self_exclusion_until, flags')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as ProfileRow | null;
}

async function minAge(homeCountry: string, homeRegion: string | null, locCountry: string | null, locRegion: string | null): Promise<number> {
  const { data, error } = await db().rpc('min_age_for_place', {
    p_home_country: homeCountry,
    p_home_region: homeRegion,
    p_loc_country: locCountry,
    p_loc_region: locRegion,
  });
  if (error) throw new Error(error.message);
  return Number(data);
}

export async function recordDevice(req: Request, userId: string) {
  const hash = deviceHash(req);
  if (hash) await db().rpc('record_device', { p_user: userId, p_device_hash: hash });
}

/** GET /api/rm/profile — the signed-in player's profile (null until they finish sign-up). */
export async function profileGET(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  const profile = await loadProfile(r.user.id);
  return json({ profile: profile && { ...profile, flags: undefined } });
}

/** POST /api/rm/profile {dob: 'YYYY-MM-DD', state: 'NJ'} — completes sign-up. Age is checked here, not in the browser. */
export async function profilePOST(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  const limited = await rateLimit(`profile:${r.user.id}`, 10, 3600);
  if (limited) return limited;
  let body: { dob?: string; state?: string; country?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  const dob = String(body.dob ?? '');
  const country = String(body.country ?? 'US').toUpperCase();
  const state = country === 'US' ? String(body.state ?? '').toUpperCase() : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob))) return json({ error: 'Enter your date of birth.' }, 422);
  const { data: known } = await db().from('countries').select('code').eq('code', country).maybeSingle();
  if (!known) return json({ error: 'Choose the country you live in.' }, 422);
  if (country === 'US' && !US_STATES.has(state ?? '')) return json({ error: 'Choose the state you live in.' }, 422);
  const age = ageOn(dob);
  if (age > 120) return json({ error: 'Check your date of birth.' }, 422);

  // Log where sign-up happened (doesn't block sign-up; playing is geofenced separately).
  const geo = await checkLocation(req, r.user.id, 'signup');
  const min = await minAge(country, state, geo.country, geo.region);
  if (age < min) return json({ error: `You must be ${min} or older to play.` }, 403);

  const existing = await loadProfile(r.user.id);
  if (existing?.dob && existing.dob !== dob)
    return json({ error: 'Your date of birth is already on file. Contact support to correct it.' }, 409);
  const { error } = await db().from('profiles').upsert({ id: r.user.id, dob, state, country });
  if (error) return json({ error: error.message }, 500);
  await recordDevice(req, r.user.id);
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
  [/self_excluded/, 403, 'You’re on a break or self-excluded, so new entries are paused. You can still withdraw.'],
  [/under_age/, 403, 'You’re under the minimum age where you are right now.'],
  [/account_blocked/, 403, 'Your account is on hold. Contact support.'],
  [/location_not_eligible|location_check_required/, 403, GEO_MESSAGES.state_not_eligible],
  [/profile_required/, 403, 'Finish setting up your account first.'],
];

/** POST /api/rm/entries {picks: [{projection_id, direction}], stake_cents, idempotency_key} */
export async function entriesPOST(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  const limited = await rateLimit(`entry:${r.user.id}`, 10, 60);
  if (limited) return limited;
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

  const profile = await loadProfile(r.user.id);
  if (!profile?.dob) return json({ error: 'Finish setting up your account first.', code: 'profile_required' }, 403);

  await recordDevice(req, r.user.id);
  const geo = await checkLocation(req, r.user.id, 'entry');
  if (geo.decision === 'deny')
    return json({ error: GEO_MESSAGES[geo.reason ?? 'location_unknown'] ?? GEO_MESSAGES.location_unknown, code: 'location_denied' }, 403);

  const key = typeof body.idempotency_key === 'string' && body.idempotency_key.length >= 8 ? body.idempotency_key : `ent:${randomUUID()}`;
  const { data, error } = await db().rpc('place_entry', {
    p_user: r.user.id,
    p_picks: picks.map((p) => ({ projection_id: p.projection_id, direction: p.direction })),
    p_stake_cents: stake,
    p_key: `${r.user.id}:${key}`,
    p_geo_check: geo.id,
  });
  if (error) {
    const lim = limitMessage(error.message);
    if (lim) return json({ error: lim, code: 'limit_exceeded' }, 403);
    const hit = ENTRY_ERRORS.find(([re]) => re.test(error.message));
    if (hit) return json({ error: hit[2] }, hit[1]);
    return json({ error: 'The entry couldn’t be placed. Try again.' }, 500);
  }
  return json({ entry: data });
}

/** GET /api/rm/kyc — identity check status for the signed-in player. */
export async function kycGET(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  const rec = await latestKyc(r.user.id);
  return json({
    available: !!kycProvider(),
    status: rec?.status ?? 'none',
    reason: rec?.status === 'rejected' ? rec.reason : null,
  });
}

/** POST /api/rm/kyc — starts (or resumes) identity verification. Returns a hosted URL when the provider has one. */
export async function kycPOST(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  const limited = await rateLimit(`kyc:${r.user.id}`, 5, 3600);
  if (limited) return limited;
  const provider = kycProvider();
  if (!provider) return json({ error: 'Identity checks aren’t connected yet. Try again later.' }, 503);
  const profile = await loadProfile(r.user.id);
  if (!profile?.dob) return json({ error: 'Finish setting up your account first.', code: 'profile_required' }, 403);

  const rec = await latestKyc(r.user.id);
  if (rec?.status === 'approved') return json({ status: 'approved' });
  if (rec?.status === 'review') return json({ status: 'review' });
  if (rec?.status === 'rejected' && rec.reason === 'duplicate_identity')
    return json({ error: 'This identity is already verified on another account. Contact support.' }, 409);

  const started = await provider.start(r.user);
  const { data, error } = await db()
    .from('kyc_records')
    .insert({ user_id: r.user.id, provider: provider.name, provider_ref: started.ref, status: 'pending' })
    .select('id')
    .single();
  if (error) return json({ error: error.message }, 500);
  if (started.status === 'review') await applyDecision(data.id as number, 'review', null, null, provider.name);
  return json({ status: started.status, url: started.url });
}
