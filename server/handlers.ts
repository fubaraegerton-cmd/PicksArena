import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { applyAction, validateAction, type AdminAction } from '../src/shared/admin.js';
import { loadData, saveData, storageMode } from './storage.js';
import { audit, db, rateLimit, supabaseConfigured } from './supabase.js';
import { OperatorError, applySlateAction, loadSlate } from './slate.js';
import { applyDecision } from './kyc.js';
import { ConsoleError, addNote, failPendingDeposit, forceSettleLeg, isOperatorUser, listOperators, pendingDeposits, playerDetail, playerSearch, setOperator } from './console.js';
import { feedStatus, maybeSync } from './feed.js';
import { PaymentsOperatorError, importSettlements, paymentsView, reviewWithdrawal, simulateChargeback } from './payments.js';

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
async function operatorEmail(req: Request): Promise<string | null> {
  if (!supabaseConfigured()) return null;
  const token = bearer(req);
  if (!token || token.split('.').length !== 3) return null;
  const { data, error } = await db().auth.getUser(token);
  if (error || !isOperatorUser(data.user)) return null;
  return data.user.email ?? data.user.id;
}

async function authError(req: Request): Promise<Response | null> {
  if (await operatorEmail(req)) return null;
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
    if (supabaseConfigured()) {
      // Keep real games and scores current; never hold the board up for more than a few seconds.
      await Promise.race([maybeSync().catch(() => undefined), new Promise((r) => setTimeout(r, 4000))]);
    }
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
    if (supabaseConfigured() && new URL(req.url).searchParams.get('view') === 'feed') return json({ feed: await feedStatus() });
    if (supabaseConfigured() && new URL(req.url).searchParams.get('view') === 'compliance') return json(await complianceView());
    if (supabaseConfigured() && new URL(req.url).searchParams.get('view') === 'payments') return json(await paymentsView(await emailsById()));
    if (supabaseConfigured() && new URL(req.url).searchParams.get('view') === 'audit') return json(await auditView(new URL(req.url).searchParams));
    const view = new URL(req.url).searchParams.get('view');
    if (supabaseConfigured() && view === 'players') return json(await playerSearch(new URL(req.url).searchParams.get('q') ?? ''));
    if (supabaseConfigured() && view === 'player') {
      try {
        return json(await playerDetail(new URL(req.url).searchParams.get('id') ?? ''));
      } catch (e) {
        return json({ error: (e as Error).message }, e instanceof ConsoleError ? 404 : 500);
      }
    }
    if (supabaseConfigured() && view === 'operators') return json({ operators: await listOperators() });
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
    const act = (body as unknown as { action: string }).action;
    const by = (await operatorEmail(req)) ?? 'admin-password';
    const limited = await rateLimit(`admin:${by}`, 120, 60);
    if (limited) return limited;
    const res = await operatorAction(body, act, by);
    // These actions write their own, more detailed audit rows (database function or console).
    if (res.ok && !['addNote', 'setOperator', 'forceSettleLeg'].includes(act)) {
      const { csv: _csv, baseVersion: _v, ...details } = body as unknown as Record<string, unknown>;
      const subject = typeof details.userId === 'string' ? details.userId : null;
      await audit(`operator:${by}`, `operator.${act}`, subject, details);
    }
    return res;
  }
  return legacyAdminPOST(body);
}

async function operatorAction(body: AdminAction & { baseVersion?: number }, act: string, by: string): Promise<Response> {
  {
    try {
      if (act === 'creditFunds') return await creditFunds(body as unknown as CreditFunds);
      if (act === 'reviewWithdrawal' || act === 'importSettlements' || act === 'simulateChargeback') {
        const b = body as unknown as { paymentId?: string; approve?: boolean; reason?: string; csv?: string };
        try {
          let note = 'Saved';
          if (act === 'reviewWithdrawal') {
            await reviewWithdrawal(String(b.paymentId), !!b.approve, b.reason, `operator:${by}`);
            note = b.approve ? 'Withdrawal approved and sent for payout' : 'Withdrawal rejected and funds returned';
          } else if (act === 'importSettlements') note = `Imported ${await importSettlements(b.csv, by)} settlement rows`;
          else {
            await simulateChargeback(String(b.paymentId));
            note = 'Chargeback simulated';
          }
          return json({ ok: true, note, payments: await paymentsView(await emailsById()) });
        } catch (e) {
          return json({ error: (e as Error).message }, e instanceof PaymentsOperatorError ? 422 : 500);
        }
      }
      if (['forceSettleLeg', 'failDeposit', 'addNote', 'setOperator'].includes(act)) {
        const b = body as unknown as Record<string, string | boolean>;
        try {
          if (act === 'forceSettleLeg') await forceSettleLeg(String(b.entryId), String(b.projectionId), String(b.result), String(b.reason ?? ''), `operator:${by}`);
          else if (act === 'failDeposit') await failPendingDeposit(String(b.paymentId), String(b.reason ?? ''), `operator:${by}`);
          else if (act === 'addNote') await addNote(String(b.userId), String(b.note ?? ''), `operator:${by}`);
          else await setOperator(String(b.email ?? ''), !!b.grant, `operator:${by}`, by);
          if (act === 'failDeposit') return json({ ok: true, note: 'Deposit marked failed', payments: await paymentsView(await emailsById()) });
          return json({ ok: true });
        } catch (e) {
          return json({ error: (e as Error).message }, e instanceof ConsoleError ? 422 : 500);
        }
      }
      if (act === 'syncFeed') {
        const r = await maybeSync(true);
        if (r.error) return json({ error: `Feed sync failed: ${r.error}`, data: await loadSlate('operator') }, 502);
        const x = r.result;
        const note = x ? `Imported ${x.imported} games, updated ${x.updated}, ${x.finals} final` : 'Nothing to sync';
        return json({ ok: true, note, data: await loadSlate('operator'), feed: await feedStatus() });
      }
      if (act === 'setJurisdiction' || act === 'setCountry' || act === 'kycDecision' || act === 'setBlocked')
        return await complianceAction(body as unknown as ComplianceAction, by);
      await applySlateAction(body);
      return json({ data: await loadSlate('operator') });
    } catch (e) {
      const status = e instanceof OperatorError ? 422 : 500;
      return json({ error: (e as Error).message, data: await loadSlate('operator').catch(() => undefined) }, status);
    }
  }
}

async function legacyAdminPOST(body: AdminAction & { baseVersion?: number }): Promise<Response> {
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

type ComplianceAction =
  | { action: 'setJurisdiction'; state: string; enabled: boolean; minAge: number }
  | { action: 'setCountry'; code: string; enabled: boolean; minAge: number }
  | { action: 'kycDecision'; recordId: number; status: 'approved' | 'rejected'; reason?: string }
  | { action: 'setBlocked'; userId: string; blocked: boolean };

async function emailsById(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db().auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    data.users.forEach((u) => m.set(u.id, u.email ?? u.id));
    if (data.users.length < 1000) break;
  }
  return m;
}

/** Operator compliance view: eligible states, ID review queue, flagged accounts, recent location denials. */
async function complianceView() {
  const [j, c, k, f, g, emails] = await Promise.all([
    db().from('jurisdictions').select('state, name, enabled, min_age, updated_at, updated_by').order('name'),
    db().from('countries').select('code, name, enabled, min_age, updated_at, updated_by').neq('code', 'US').order('name'),
    db().from('kyc_records').select('id, user_id, provider, status, reason, created_at').in('status', ['pending', 'review']).order('created_at').limit(200),
    db().from('profiles').select('id, state, kyc_status, flags, dob').neq('flags', '{}').limit(200),
    db().from('geo_checks').select('id, user_id, action, region, country, is_vpn, reason, created_at').eq('decision', 'deny').order('created_at', { ascending: false }).limit(50),
    emailsById(),
  ]);
  for (const r of [j, c, k, f, g]) if (r.error) throw new Error(r.error.message);
  const email = (id: string) => emails.get(id) ?? id;
  return {
    jurisdictions: j.data,
    countries: c.data,
    kycQueue: (k.data ?? []).map((r) => ({ ...r, email: email(r.user_id as string) })),
    flagged: (f.data ?? []).map((r) => ({ ...r, email: email(r.id as string) })),
    geoDenials: (g.data ?? []).map((r) => ({ ...r, email: email(r.user_id as string) })),
  };
}

async function complianceAction(a: ComplianceAction, by: string): Promise<Response> {
  if (a.action === 'setJurisdiction') {
    const state = String(a.state ?? '').toUpperCase();
    const minAge = Number(a.minAge);
    if (!/^[A-Z]{2}$/.test(state)) return json({ error: 'Unknown state.' }, 422);
    if (!Number.isInteger(minAge) || minAge < 18 || minAge > 25) return json({ error: 'Minimum age must be 18 to 25.' }, 422);
    const { error, count } = await db()
      .from('jurisdictions')
      .update({ enabled: !!a.enabled, min_age: minAge, updated_at: new Date().toISOString(), updated_by: by }, { count: 'exact' })
      .eq('state', state);
    if (error) return json({ error: error.message }, 500);
    if (!count) return json({ error: 'Unknown state.' }, 404);
  } else if (a.action === 'setCountry') {
    const code = String(a.code ?? '').toUpperCase();
    const minAge = Number(a.minAge);
    if (!/^[A-Z]{2}$/.test(code) || code === 'US') return json({ error: 'Unknown country. US play is set state by state.' }, 422);
    if (!Number.isInteger(minAge) || minAge < 18 || minAge > 25) return json({ error: 'Minimum age must be 18 to 25.' }, 422);
    const { error, count } = await db()
      .from('countries')
      .update({ enabled: !!a.enabled, min_age: minAge, updated_at: new Date().toISOString(), updated_by: by }, { count: 'exact' })
      .eq('code', code);
    if (error) return json({ error: error.message }, 500);
    if (!count) return json({ error: 'Unknown country.' }, 404);
  } else if (a.action === 'kycDecision') {
    if (!['approved', 'rejected'].includes(a.status)) return json({ error: 'Choose approve or reject.' }, 422);
    if (a.status === 'rejected' && !(a.reason ?? '').trim()) return json({ error: 'Give a reason for rejecting.' }, 422);
    try {
      await applyDecision(Number(a.recordId), a.status, a.reason?.trim() || null, null, `operator:${by}`);
    } catch (e) {
      return json({ error: /already_decided/.test((e as Error).message) ? 'That check was already decided.' : (e as Error).message }, 422);
    }
  } else if (a.action === 'setBlocked') {
    const { data: p, error: pe } = await db().from('profiles').select('flags').eq('id', a.userId).maybeSingle();
    if (pe || !p) return json({ error: pe?.message ?? 'Player not found.' }, 404);
    const flags = { ...(p.flags as Record<string, unknown>), blocked: !!a.blocked, blocked_by: by, blocked_at: new Date().toISOString() };
    const { error } = await db().from('profiles').update({ flags }).eq('id', a.userId);
    if (error) return json({ error: error.message }, 500);
  }
  return json({ ok: true, compliance: await complianceView() });
}

/** Audit log viewer: newest first, optional filters by action prefix or player email. */
async function auditView(params: URLSearchParams) {
  const emails = await emailsById();
  let q = db().from('audit_log').select('id, at, actor, action, subject_user, entity, entity_id, details').order('id', { ascending: false }).limit(200);
  const action = params.get('action');
  if (action) q = q.like('action', `${action.replace(/[%_]/g, '')}%`);
  const email = params.get('email')?.toLowerCase();
  if (email) {
    const id = [...emails.entries()].find(([, e]) => e.toLowerCase() === email)?.[0];
    if (!id) return { rows: [] };
    q = q.eq('subject_user', id);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const name = (actor: string) => {
    const m = /^player:(.+)$/.exec(actor);
    return m ? `player ${emails.get(m[1]) ?? m[1]}` : actor;
  };
  return {
    rows: (data ?? []).map((r) => ({ ...r, actor: name(r.actor as string), subject: r.subject_user ? emails.get(r.subject_user as string) ?? r.subject_user : null })),
  };
}
