import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { applyAction, validateAction, type AdminAction } from '../src/shared/admin.js';
import { loadData, saveData, storageMode } from './storage.js';

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

function authError(req: Request): Response | null {
  if (!process.env.ADMIN_PASSWORD)
    return json({ error: 'Admin is not set up yet. Add an ADMIN_PASSWORD environment variable in Vercel.' }, 503);
  if (!passwordOk(bearer(req))) return json({ error: 'Wrong admin password.' }, 401);
  return null;
}

/** GET /api/board — public: admin games and picks for the app */
export async function boardGET(): Promise<Response> {
  try {
    const data = await loadData();
    return json(data, 200, { 'cache-control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=30' });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

/** GET /api/admin — checks the password and returns data + storage status */
export async function adminGET(req: Request): Promise<Response> {
  const err = authError(req);
  if (err) return err;
  try {
    return json({ data: await loadData(), storage: storageMode() });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

/** POST /api/admin — apply one admin action */
export async function adminPOST(req: Request): Promise<Response> {
  const err = authError(req);
  if (err) return err;
  let body: AdminAction & { baseVersion?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
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
