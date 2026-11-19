import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { applyAction, validateAction, type AdminAction } from '../src/shared/admin.js';
import { loadData, saveData, storageMode } from './storage.js';
import { db, supabaseConfigured } from './supabase.js';
import { OperatorError, applySlateAction, loadSlate } from './slate.js';

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

/** Constant-time password check (hash both sides so lengths match). */
function passwordOk(given: string | null): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Operator = a signed-in Supabase account whose app_metadata.role is 'operator' (only the server can set it). */
async function isOperator(req: Request): Promise<boolean> {
  if (!supabaseConfigured()) return false;
  const token = bearer(req);
  if (!token || token.split('.').length !== 3) return false;
  const { data, error } = await db().auth.getUser(token);
  return !error && data.user?.app_metadata?.role === 'operator';
}

async function authError(req: Request): Promise<Response | null> {
  if (await isOperator(req)) return null;
  if (supabaseConfigured() && !process.env.ADMIN_PASSWORD)
    return json({ error: 'Sign in with an operator account to use the dashboard.' }, 401);
  if (!process.env.ADMIN_PASSWORD)
    return json({ error: 'Admin is not set up yet. Add an ADMIN_PASSWORD environment variable in Vercel.' }, 503);
  if (!passwordOk(bearer(req))) return json({ error: 'Wrong admin password.' }, 401);
  return null;
}

/** GET /api/board — public: admin games and picks for the app */
export async function boardGET(): Promise<Response> {
  try {
    const data = supabaseConfigured() ? await loadSlate('public') : await loadData();
    return json(data, 200, { 'cache-control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=30' });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

/** GET /api/admin — checks the password and returns data + storage status */
export async function adminGET(req: Request): Promise<Response> {
  const err = await authError(req);
  if (err) return err;
  try {
    if (supabaseConfigured()) return json({ data: await loadSlate('operator'), storage: 'supabase' });
    return json({ data: await loadData(), storage: storageMode() });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

/** POST /api/admin — apply one admin action */
export async function adminPOST(req: Request): Promise<Response> {
  const err = await authError(req);
  if (err) return err;
  let body: AdminAction & { baseVersion?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  if (supabaseConfigured()) {
    try {
      if ((body as unknown as { action: string }).action === 'creditFunds') return await creditFunds(body as unknown as CreditFunds);
      await applySlateAction(body);
      return json({ data: await loadSlate('operator') });
    } catch (e) {
      const status = e instanceof OperatorError ? 422 : 500;
      return json({ error: (e as Error).message, data: await loadSlate('operator').catch(() => undefined) }, status);
    }
  }
  try {
    const data = await loadData();
    if (typeof body.baseVersion === 'number' && body.baseVersion !== data.version)
      return json({ error: 'Someone else changed the data. Reloaded the latest version — try again.', data }, 409);
    const problem = validateAction(body, data);
    if (problem) return json({ error: problem }, 422);
    const now = Date.now();
    const next = applyAction(body, data, () => randomUUID().slice(0, 8), now);
    next.version = data.version + 1;
    next.updatedAt = now;
    await saveData(next);
    return json({ data: next });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

interface CreditFunds {
  action: 'creditFunds';
  email: string;
  amountCents: number;
  reason: string;
}

/**
 * Operator adjustment: credits (or debits) a player's cash with a recorded reason.
 * Used for test funds until deposits open, and for corrections. Every one is a ledger row.
 */
async function creditFunds(b: CreditFunds): Promise<Response> {
  const email = String(b.email ?? '').trim().toLowerCase();
  const amount = Number(b.amountCents);
  const reason = String(b.reason ?? '').trim();
  if (!email.includes('@')) return json({ error: 'Enter the player’s email.' }, 422);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) return json({ error: 'Enter an amount between $0.01 and $10,000.' }, 422);
  if (reason.length < 3) return json({ error: 'Give a reason. It’s stored on the ledger.' }, 422);
  let userId: string | undefined;
  for (let page = 1; page <= 50 && !userId; page++) {
    const { data, error } = await db().auth.admin.listUsers({ page, perPage: 200 });
    if (error) return json({ error: error.message }, 500);
    userId = data.users.find((u) => u.email?.toLowerCase() === email)?.id;
    if (data.users.length < 200) break;
  }
  if (!userId) return json({ error: 'No player with that email.' }, 404);
  const { error } = await db().rpc('operator_adjust', {
    p_user: userId,
    p_amount_cents: amount,
    p_reason: `operator: ${reason}`,
    p_key: `adj:${randomUUID()}`,
  });
  if (error) return json({ error: /insufficient_funds/.test(error.message) ? 'That would take the player’s balance below zero.' : error.message }, 422);
  return json({ ok: true, data: await loadSlate('operator') });
}
