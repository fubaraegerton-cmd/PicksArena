import { createHash } from 'node:crypto';
import { db } from './supabase.js';

/**
 * Server-side geofence. Every entry (and, from phase 4, every deposit and withdrawal)
 * runs this first; the decision is logged to geo_checks and place_entry refuses to run
 * without a fresh 'allow' row, so the database enforces it too.
 *
 * Location source, in order:
 *   1. Vercel's IP geolocation headers (x-vercel-ip-country / -country-region) in production.
 *   2. GEO_DEV_LOCATION="US-NJ" — local development only (ignored on Vercel).
 * VPN/proxy detection: ipinfo.io privacy API when IPINFO_TOKEN is set. Set
 * GEO_REQUIRE_VPN_CHECK=true in production so a missing/failed VPN check denies.
 * A licensed launch will usually swap this for a dedicated provider (e.g. GeoComply);
 * keep the same GeoResult shape and the rest of the app doesn't change.
 */

export type GeoAction = 'signup' | 'entry' | 'deposit' | 'withdrawal';

export interface GeoResult {
  id: number;
  decision: 'allow' | 'deny';
  reason: string | null;
  country: string | null;
  region: string | null;
}

export const GEO_MESSAGES: Record<string, string> = {
  location_unknown: 'We couldn’t confirm your location. Turn off any VPN or private relay and try again.',
  outside_us: 'Real-money play isn’t available where you are yet.',
  state_not_eligible: 'Real-money play isn’t available in your current state yet.',
  country_not_eligible: 'Real-money play isn’t available in your country yet. You can still browse the board.',
  vpn_or_proxy: 'Turn off your VPN, proxy or private relay to play.',
  vpn_check_unavailable: 'We couldn’t verify your connection right now. Try again in a moment.',
};

export function clientIp(req: Request): string | null {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : null;
}

/** Hash of the client's device id (sent as x-device-id). Never store the raw id. */
export function deviceHash(req: Request): string | null {
  const id = req.headers.get('x-device-id');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return createHash('sha256').update(`picksarena-device:${id}`).digest('hex');
}

async function vpnCheck(ip: string | null): Promise<boolean | null> {
  const token = process.env.IPINFO_TOKEN;
  if (!token || !ip) return null;
  try {
    const res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/privacy?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const p = (await res.json()) as Record<string, boolean>;
    return !!(p.vpn || p.proxy || p.tor || p.relay || p.hosting);
  } catch {
    return null;
  }
}

export async function checkLocation(req: Request, userId: string, action: GeoAction): Promise<GeoResult> {
  let country = req.headers.get('x-vercel-ip-country');
  let region = req.headers.get('x-vercel-ip-country-region');
  let provider = 'vercel-ip';
  if (!process.env.VERCEL && process.env.GEO_DEV_LOCATION) {
    [country, region] = process.env.GEO_DEV_LOCATION.toUpperCase().split('-');
    provider = 'dev-override';
  }
  const ip = clientIp(req);
  const isVpn = await vpnCheck(ip);
  if (isVpn !== null) provider += '+ipinfo';

  let reason: string | null = null;
  if (!country || (country === 'US' && !region)) reason = 'location_unknown';
  else if (isVpn === true) reason = 'vpn_or_proxy';
  else if (isVpn === null && process.env.GEO_REQUIRE_VPN_CHECK === 'true') reason = 'vpn_check_unavailable';
  else {
    const { data, error } = await db().rpc('place_enabled', { p_country: country, p_region: region });
    if (error) throw new Error(error.message);
    if (data !== true) reason = country === 'US' ? 'state_not_eligible' : 'country_not_eligible';
  }

  const decision = reason ? 'deny' : 'allow';
  const { data, error } = await db()
    .from('geo_checks')
    .insert({
      user_id: userId,
      action,
      ip: ip && /^[0-9a-f.:]+$/i.test(ip) ? ip : null,
      country: country?.slice(0, 2) ?? null,
      region: region ?? null,
      is_vpn: isVpn,
      provider,
      decision,
      reason,
      device_hash: deviceHash(req),
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id as number, decision, reason, country, region };
}
