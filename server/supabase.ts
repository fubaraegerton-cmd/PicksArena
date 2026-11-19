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

/**
 * Minimum age to play. Most licensed US pick'em states are 18+, some 19+ or 21+.
 * Until the per-state table is configured, default to the strictest (21).
 */
export function minimumAge(_state: string | null | undefined): number {
  const n = Number(process.env.MIN_PLAYER_AGE ?? 21);
  return Number.isFinite(n) && n >= 18 ? n : 21;
}

export function ageOn(dob: string, now = new Date()): number {
  const [y, m, d] = dob.split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  if (md < m * 100 + d) age--;
  return age;
}
