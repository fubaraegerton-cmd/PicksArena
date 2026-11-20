import { audit, db, rateLimit } from './supabase.js';
import { requirePlayer } from './rm.js';

/**
 * Responsible gaming (phase 5). Limits and exclusions are enforced in the database
 * (start_deposit / place_entry); these endpoints only read and change the settings.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const KINDS = ['deposit', 'stake', 'loss'] as const;
const PERIODS = ['day', 'week', 'month'] as const;
const SINCE: Record<string, string> = { day: '24 hours', week: '7 days', month: '30 days' };

/** GET /api/rm/rg — limits (current, pending, used), exclusion and spend summary. */
export async function rgGET(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  const uid = r.user.id;
  const [rows, profile, summary, exclusions] = await Promise.all([
    db().from('player_limits').select('kind, period, amount_cents, effective_at, id').eq('user_id', uid).order('id', { ascending: false }),
    db().from('profiles').select('self_exclusion_until').eq('id', uid).maybeSingle(),
    db().rpc('spend_summary', { p_user: uid }),
    db().from('player_exclusions').select('kind, ends_at, created_at').eq('user_id', uid).order('id', { ascending: false }).limit(1),
  ]);
  for (const x of [rows, profile, summary, exclusions]) if (x.error) return json({ error: x.error.message }, 500);
  const now = Date.now();
  const combos = KINDS.flatMap((kind) => PERIODS.map((period) => ({ kind, period })));
  const usage = await Promise.all(
    combos.map(({ kind, period }) =>
      db().rpc('limit_usage', {
        p_user: uid,
        p_kind: kind,
        p_since: new Date(now - (period === 'day' ? 864e5 : period === 'week' ? 7 * 864e5 : 30 * 864e5)).toISOString(),
      }),
    ),
  );
  const limits = [];
  for (const [i, { kind, period }] of combos.entries()) {
      const mine = (rows.data ?? []).filter((x) => x.kind === kind && x.period === period);
      const current = mine.find((x) => Date.parse(x.effective_at) <= now);
      const pending = mine.find((x) => Date.parse(x.effective_at) > now && (!current || x.id > current.id));
      const used = usage[i].data;
      limits.push({
        kind,
        period,
        window: SINCE[period],
        current_cents: current?.amount_cents ?? null,
        used_cents: Number(used ?? 0),
        pending: pending ? { amount_cents: pending.amount_cents, effective_at: pending.effective_at } : null,
      });
    }
  const until = profile.data?.self_exclusion_until ?? null;
  return json({
    limits,
    exclusion: until && (until === 'infinity' || Date.parse(until) > now) ? { until, kind: exclusions.data?.[0]?.kind ?? 'self_exclusion' } : null,
    summary: summary.data,
  });
}

/**
 * POST /api/rm/rg
 *   {action: 'setLimit', kind, period, amount_cents | null}
 *   {action: 'exclude', kind: 'cool_off' | 'self_exclusion', days: number | null, confirm: true}
 */
export async function rgPOST(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  const limited = await rateLimit(`rg:${r.user.id}`, 30, 3600);
  if (limited) return limited;
  let b: { action?: string; kind?: string; period?: string; amount_cents?: number | null; days?: number | null; confirm?: boolean };
  try {
    b = await req.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  const actor = `player:${r.user.id}`;
  if (b.action === 'setLimit') {
    if (!KINDS.includes(b.kind as never) || !PERIODS.includes(b.period as never)) return json({ error: 'Choose a limit type and period.' }, 422);
    const amount = b.amount_cents === null ? null : Number(b.amount_cents);
    if (amount !== null && (!Number.isInteger(amount) || amount < 100 || amount > 10_000_000))
      return json({ error: 'Enter a limit between $1 and $100,000.' }, 422);
    const { data, error } = await db().rpc('set_limit', { p_user: r.user.id, p_kind: b.kind, p_period: b.period, p_amount_cents: amount, p_actor: actor });
    if (error) return json({ error: error.message }, 500);
    const immediate = Date.parse(data.effective_at) <= Date.now() + 5_000;
    return json({
      ok: true,
      immediate,
      message: immediate
        ? 'Your new limit is in effect now.'
        : 'Raising or removing a limit takes effect in 24 hours. Your current limit stays in place until then.',
    });
  }
  if (b.action === 'exclude') {
    if (!b.confirm) return json({ error: 'Confirm to continue.' }, 422);
    const days = b.days === null ? null : Number(b.days);
    const { data, error } = await db().rpc('set_exclusion', { p_user: r.user.id, p_kind: b.kind, p_days: days, p_actor: actor });
    if (error) return json({ error: /invalid/.test(error.message) ? 'Choose one of the listed lengths.' : error.message }, 422);
    await audit(actor, 'exclusion.requested', r.user.id, { kind: b.kind, days });
    return json({ ok: true, until: data });
  }
  return json({ error: 'Unknown action.' }, 400);
}
