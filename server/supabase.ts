import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

/**
 * Server-side Supabase access. Uses the SECRET key, so it bypasses RLS: only call
 * money functions from here after authenticating the player.
 */
let admin: SupabaseClient | null = null;

export function supabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

export function db(): SupabaseClient {
  if (!supabaseConfigured()) throw new Error('Supabase is not configured on the server.');
  admin ??= createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}

/** Verifies the player's Supabase access token (Authorization: Bearer …). */
export async function playerFrom(req: Request): Promise<User | null> {
  const h = req.headers.get('authorization') ?? '';
  if (!h.startsWith('Bearer ')) return null;
  const { data, error } = await db().auth.getUser(h.slice(7));
  if (error || !data.user) return null;
  return data.user;
}

export function ageOn(dob: string, now = new Date()): number {
  const [y, m, d] = dob.split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  if (md < m * 100 + d) age--;
  return age;
}

/**
 * Database-backed fixed-window rate limit. Returns a 429 Response when exceeded, else null.
 * Fails open (allows) only if the limiter itself errors, so an outage can't lock everyone out.
 */
export async function rateLimit(key: string, max: number, windowSeconds: number): Promise<Response | null> {
  const { data, error } = await db().rpc('hit_rate_limit', { p_key: key, p_max: max, p_window_seconds: windowSeconds });
  if (error || data !== false) return null;
  return new Response(JSON.stringify({ error: 'Too many requests. Wait a moment and try again.' }), {
    status: 429,
    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(windowSeconds) },
  });
}

/** Records an explicit audit entry (operator actions, player settings). Never throws. */
export async function audit(actor: string, action: string, subject: string | null, details: Record<string, unknown> = {}) {
  await db()
    .rpc('log_audit', { p_actor: actor, p_action: action, p_subject: subject, p_entity: null, p_entity_id: null, p_details: details })
    .then(
      () => undefined,
      () => undefined,
    );
}

const PERIOD_WORD: Record<string, string> = { day: 'today', week: 'this week', month: 'this month' };

/** Turns "limit_exceeded:<kind>:<period>:<remaining_cents>" from the database into a player message. */
export function limitMessage(dbMessage: string): string | null {
  const m = /limit_exceeded:(\w+):(\w+):(\d+)/.exec(dbMessage);
  if (!m) return null;
  const [, kind, period, remaining] = m;
  const left = `$${(Number(remaining) / 100).toFixed(2)}`;
  const word = period === 'day' ? 'daily' : period === 'week' ? 'weekly' : 'monthly';
  return Number(remaining) > 0
    ? `That would go over your ${word} ${kind} limit. You can ${kind === 'deposit' ? 'deposit' : 'stake'} up to ${left} more ${PERIOD_WORD[period]}.`
    : `You’ve reached your ${word} ${kind} limit. It frees up on a rolling basis.`;
}
