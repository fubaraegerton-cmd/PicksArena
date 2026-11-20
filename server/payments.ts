import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { db, limitMessage, rateLimit } from './supabase.js';
import { GEO_MESSAGES, checkLocation } from './geo.js';
import { loadProfile, recordDevice, requirePlayer } from './rm.js';

/**
 * Payments (phase 4). The processor sits behind PaymentProvider so a gaming-approved
 * processor can be dropped in by implementing four methods. Money never moves on a
 * browser redirect: only a webhook whose signature verifies, processed by the database
 * function process_payment_event (exactly-once, amount must match), credits or pays out.
 *
 * PAYMENTS_PROVIDER:
 *   sandbox — built-in simulated processor (hosted checkout page + signed webhooks).
 *             Refuses to run on Vercel production unless PAYMENTS_SANDBOX_ALLOW_PRODUCTION=true
 *             (pre-launch testing only — it creates balances without real money).
 *   (unset) — deposits and withdrawals are closed.
 */

export type EventType = 'deposit.succeeded' | 'deposit.failed' | 'deposit.reversed' | 'payout.paid' | 'payout.failed';

export interface NormalizedEvent {
  eventId: string;
  type: EventType;
  providerRef: string;
  amountCents: number | null;
  method?: { token: string; kind: 'card' | 'bank' | 'wallet'; label: string; holderName?: string };
  reason?: string;
  raw: unknown;
}

export interface PaymentProvider {
  name: string;
  /** Hosted checkout for a deposit we already recorded. */
  createCheckout(p: { paymentId: string; amountCents: number; userId: string; origin: string }): Promise<{ providerRef: string; redirectUrl: string }>;
  /** Starts a payout for an approved withdrawal. `afterRefSaved` runs once our record has the ref. */
  createPayout(p: { paymentId: string; amountCents: number; methodToken: string }): Promise<{ providerRef: string; afterRefSaved?: () => Promise<void> }>;
  /** Verifies the signature and returns normalized events, or null if the signature is invalid. */
  parseWebhook(req: Request, raw: string): NormalizedEvent[] | null;
  /** Optional: the processor's settlement report for reconciliation. */
  settlementReport?(): Promise<{ providerRef: string; direction: 'deposit' | 'withdrawal'; amountCents: number; settledAt?: string }[]>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** "t=<unix>,v1=<hex>" HMAC-SHA256 over "<t>.<raw body>", 5-minute replay window. */
export function signPayload(raw: string, secret: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}
export function verifySignature(header: string | null, raw: string, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const parts = header.split(/[,\s]+/).map((p) => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// ---------------------------------------------------------------------------
// Sandbox processor
// ---------------------------------------------------------------------------

function sandboxSecret(): string {
  return process.env.PAYMENTS_SANDBOX_SECRET ?? (process.env.VERCEL ? '' : 'sandbox-local-secret');
}

/** Delivers a signed event to our own webhook handler, exactly like a processor would over HTTP. */
async function deliverSandboxEvent(body: Record<string, unknown>): Promise<{ status: number; results: unknown }> {
  const raw = JSON.stringify(body);
  const req = new Request('http://internal/api/pay/webhook?provider=sandbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sandbox-signature': signPayload(raw, sandboxSecret()) },
    body: raw,
  });
  const res = await webhookPOST(req);
  return { status: res.status, results: await res.json().catch(() => null) };
}

export const sandbox: PaymentProvider & {
  simulate(type: EventType, ref: string, amountCents: number, extra?: Partial<NormalizedEvent>): Promise<{ status: number; results: unknown }>;
} = {
  name: 'sandbox',
  async createCheckout({ amountCents, origin }) {
    const providerRef = `sbx_dep_${randomUUID()}`;
    return { providerRef, redirectUrl: `${origin}/pay/sandbox?ref=${encodeURIComponent(providerRef)}&amount=${amountCents}` };
  },
  async createPayout({ amountCents }) {
    const providerRef = `sbx_po_${randomUUID()}`;
    return { providerRef, afterRefSaved: async () => void (await sandbox.simulate('payout.paid', providerRef, amountCents)) };
  },
  parseWebhook(req, raw) {
    if (!verifySignature(req.headers.get('sandbox-signature'), raw, sandboxSecret())) return null;
    const e = JSON.parse(raw) as { id: string; type: EventType; data: { ref: string; amount_cents: number | null; method?: NormalizedEvent['method']; reason?: string } };
    return [{ eventId: e.id, type: e.type, providerRef: e.data.ref, amountCents: e.data.amount_cents, method: e.data.method, reason: e.data.reason, raw: e }];
  },
  async settlementReport() {
    // The sandbox's "processor records": every event it delivered that completed.
    const { data, error } = await db()
      .from('payment_events')
      .select('provider_ref, type, amount_cents, received_at, result')
      .eq('provider', 'sandbox')
      .in('result', ['credited', 'paid']);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      providerRef: r.provider_ref as string,
      direction: (r.type as string).startsWith('deposit') ? ('deposit' as const) : ('withdrawal' as const),
      amountCents: Number(r.amount_cents),
      settledAt: r.received_at as string,
    }));
  },
  async simulate(type, ref, amountCents, extra = {}) {
    return deliverSandboxEvent({
      id: `evt_${randomUUID()}`,
      type,
      data: { ref, amount_cents: amountCents, method: extra.method, reason: extra.reason },
    });
  },
};

export function paymentProvider(): PaymentProvider | null {
  if (process.env.PAYMENTS_PROVIDER === 'sandbox') {
    if (process.env.VERCEL_ENV === 'production' && process.env.PAYMENTS_SANDBOX_ALLOW_PRODUCTION !== 'true') return null;
    if (!sandboxSecret()) return null;
    return sandbox;
  }
  return null;
}

const providers: Record<string, PaymentProvider> = { sandbox };

// ---------------------------------------------------------------------------
// Player endpoints
// ---------------------------------------------------------------------------

const MONEY_ERRORS: [RegExp, number, string][] = [
  [/insufficient_funds/, 402, 'That’s more than your available balance.'],
  [/deposit_below_minimum/, 422, 'The minimum deposit is $10.'],
  [/deposit_above_maximum/, 422, 'The maximum deposit is $2,500 at a time.'],
  [/withdrawal_below_minimum/, 422, 'The minimum withdrawal is $10.'],
  [/kyc_required/, 403, 'Verify your identity on the Account page before withdrawing.'],
  [/method_not_found|method_not_verified/, 422, 'Withdrawals go back to a payment method you’ve deposited with. Choose one of those.'],
  [/withdrawal_not_cancellable/, 409, 'That withdrawal is already being processed.'],
  [/self_excluded/, 403, 'You’re on a break or self-excluded, so deposits are paused. You can still withdraw.'],
  [/account_blocked/, 403, 'Your account is on hold. Contact support.'],
  [/under_age/, 403, 'You’re under the minimum age where you are right now.'],
  [/location_not_eligible|location_check_required/, 403, GEO_MESSAGES.state_not_eligible],
  [/profile_required/, 403, 'Finish setting up your account first.'],
];
const moneyError = (msg: string) => {
  const lim = limitMessage(msg);
  if (lim) return json({ error: lim, code: 'limit_exceeded' }, 403);
  const hit = MONEY_ERRORS.find(([re]) => re.test(msg));
  return hit ? json({ error: hit[2] }, hit[1]) : json({ error: 'That didn’t go through. Try again.' }, 500);
};

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** POST /api/pay/deposit {amount_cents, idempotency_key} → {redirectUrl} to the processor's hosted checkout. */
export async function depositPOST(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  const limited = await rateLimit(`deposit:${r.user.id}`, 5, 600);
  if (limited) return limited;
  const provider = paymentProvider();
  if (!provider) return json({ error: 'Deposits aren’t open yet.' }, 503);
  const body = await readJson<{ amount_cents?: number; idempotency_key?: string }>(req);
  const amount = Number(body?.amount_cents);
  if (!Number.isInteger(amount)) return json({ error: 'Enter an amount.' }, 422);
  const profile = await loadProfile(r.user.id);
  if (!profile?.dob) return json({ error: 'Finish setting up your account first.', code: 'profile_required' }, 403);

  await recordDevice(req, r.user.id);
  const geo = await checkLocation(req, r.user.id, 'deposit');
  if (geo.decision === 'deny') return json({ error: GEO_MESSAGES[geo.reason ?? 'location_unknown'], code: 'location_denied' }, 403);

  const key = `${r.user.id}:dep:${typeof body?.idempotency_key === 'string' && body.idempotency_key.length >= 8 ? body.idempotency_key : randomUUID()}`;
  const { data: pay, error } = await db().rpc('start_deposit', {
    p_user: r.user.id,
    p_amount_cents: amount,
    p_provider: provider.name,
    p_key: key,
    p_geo: geo.id,
  });
  if (error) return moneyError(error.message);
  if (pay.provider_ref) return json({ error: 'That deposit was already started. Check your wallet history.' }, 409);

  const origin = new URL(req.url).origin;
  const checkout = await provider.createCheckout({ paymentId: pay.id, amountCents: amount, userId: r.user.id, origin });
  const { error: refErr } = await db().rpc('set_payment_ref', { p_payment: pay.id, p_ref: checkout.providerRef });
  if (refErr) return json({ error: refErr.message }, 500);
  return json({ redirectUrl: checkout.redirectUrl, paymentId: pay.id });
}

/** POST /api/pay/withdraw {amount_cents, method_id, idempotency_key} */
export async function withdrawPOST(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  const limited = await rateLimit(`withdraw:${r.user.id}`, 5, 3600);
  if (limited) return limited;
  if (!paymentProvider()) return json({ error: 'Withdrawals aren’t open yet.' }, 503);
  const body = await readJson<{ amount_cents?: number; method_id?: string; idempotency_key?: string }>(req);
  const amount = Number(body?.amount_cents);
  if (!Number.isInteger(amount)) return json({ error: 'Enter an amount.' }, 422);
  if (!/^[0-9a-f-]{36}$/i.test(body?.method_id ?? '')) return json({ error: 'Choose where to send the money.' }, 422);

  await recordDevice(req, r.user.id);
  const geo = await checkLocation(req, r.user.id, 'withdrawal');
  if (geo.decision === 'deny') return json({ error: GEO_MESSAGES[geo.reason ?? 'location_unknown'], code: 'location_denied' }, 403);

  const key = `${r.user.id}:wd:${typeof body?.idempotency_key === 'string' && body.idempotency_key.length >= 8 ? body.idempotency_key : randomUUID()}`;
  const { data, error } = await db().rpc('request_withdrawal', {
    p_user: r.user.id,
    p_amount_cents: amount,
    p_method: body!.method_id,
    p_key: key,
    p_geo: geo.id,
  });
  if (error) return moneyError(error.message);
  return json({ payment: { id: data.id, status: data.status } });
}

/** POST /api/pay/withdraw-cancel {payment_id} */
export async function withdrawCancelPOST(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  const body = await readJson<{ payment_id?: string }>(req);
  const { error } = await db().rpc('cancel_withdrawal', { p_user: r.user.id, p_payment: body?.payment_id });
  if (error) return moneyError(error.message);
  return json({ ok: true });
}

/** POST /api/pay/webhook?provider=<name> — the only way money moves in or out. */
export async function webhookPOST(req: Request) {
  const name = new URL(req.url).searchParams.get('provider') ?? '';
  const provider = providers[name];
  if (!provider) return json({ error: 'unknown provider' }, 404);
  const raw = await req.text();
  let events: NormalizedEvent[] | null;
  try {
    events = provider.parseWebhook(req, raw);
  } catch {
    return json({ error: 'malformed event' }, 400);
  }
  if (!events) return json({ error: 'invalid signature' }, 401);
  const results: { eventId: string; result: string }[] = [];
  for (const e of events) {
    const holderHash = e.method?.holderName
      ? createHash('sha256').update(`${process.env.KYC_HASH_SALT ?? 'picksarena-kyc'}|${e.method.holderName.normalize('NFKD').replace(/[^a-z]/gi, '').toLowerCase()}`).digest('hex')
      : null;
    const { data, error } = await db().rpc('process_payment_event', {
      p_provider: provider.name,
      p_event_id: e.eventId,
      p_type: e.type,
      p_ref: e.providerRef,
      p_amount_cents: e.amountCents,
      p_payload: e.raw as object,
      p_method_token: e.method?.token ?? null,
      p_method_kind: e.method?.kind ?? null,
      p_method_label: e.method?.label ?? null,
      p_holder_hash: holderHash,
      p_reason: e.reason ?? null,
    });
    // A database error makes the processor retry; a duplicate retry is a no-op.
    if (error) return json({ error: 'processing failed', eventId: e.eventId }, /duplicate key/.test(error.message) ? 200 : 500);
    results.push({ eventId: e.eventId, result: data as string });
  }
  return json({ received: true, results });
}

/**
 * POST /api/pay/sandbox {ref, outcome: 'approve'|'decline', last4?} — the sandbox processor's
 * hosted checkout "Pay" button. Acts as the processor: charges the amount it was asked for
 * and sends us a signed webhook. Only the paying player can complete their own checkout.
 */
export async function sandboxCheckoutPOST(req: Request) {
  const r = await requirePlayer(req);
  if (r.error) return r.error;
  if (paymentProvider() !== sandbox) return json({ error: 'The sandbox processor is off.' }, 404);
  const limited = await rateLimit(`sandbox:${r.user.id}`, 10, 600);
  if (limited) return limited;
  const body = await readJson<{ ref?: string; outcome?: string; last4?: string }>(req);
  const { data: pay, error } = await db()
    .from('payments')
    .select('id, user_id, amount_cents, status')
    .eq('provider', 'sandbox')
    .eq('provider_ref', body?.ref ?? '')
    .maybeSingle();
  if (error || !pay || pay.user_id !== r.user.id) return json({ error: 'Payment not found.' }, 404);
  if (pay.status !== 'created') return json({ error: 'This payment is already finished.', status: pay.status }, 409);
  const last4 = /^\d{4}$/.test(body?.last4 ?? '') ? body!.last4! : '4242';
  const token = `sbx_card_${createHash('sha256').update(`${r.user.id}:${last4}`).digest('hex').slice(0, 24)}`;
  const out =
    body?.outcome === 'decline'
      ? await sandbox.simulate('deposit.failed', body.ref!, Number(pay.amount_cents), { reason: 'card_declined' })
      : await sandbox.simulate('deposit.succeeded', body!.ref!, Number(pay.amount_cents), {
          method: { token, kind: 'card', label: `Sandbox card •••• ${last4}`, holderName: r.user.email ?? undefined },
        });
  return json(out, out.status);
}

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------

export async function paymentsView(emails: Map<string, string>) {
  const [queue, recent, recon] = await Promise.all([
    db()
      .from('payments')
      .select('id, user_id, amount_cents, status, created_at, method_id, payment_methods(label, status)')
      .eq('direction', 'withdrawal')
      .eq('status', 'requested')
      .order('created_at')
      .limit(100),
    db()
      .from('payments')
      .select('id, user_id, direction, amount_cents, status, provider, provider_ref, failure_reason, created_at, reviewed_by')
      .order('created_at', { ascending: false })
      .limit(50),
    db().rpc('reconcile_payments'),
  ]);
  for (const x of [queue, recent, recon]) if (x.error) throw new Error(x.error.message);
  const ids = [...new Set((queue.data ?? []).map((p) => p.user_id as string))];
  const [profiles, wallets, totals] = await Promise.all([
    ids.length ? db().from('profiles').select('id, kyc_status, state, flags').in('id', ids) : Promise.resolve({ data: [], error: null }),
    ids.length ? db().from('wallets').select('user_id, available_cents, held_cents').in('user_id', ids) : Promise.resolve({ data: [], error: null }),
    ids.length ? db().from('payments').select('user_id, direction, amount_cents, status').in('user_id', ids).in('status', ['succeeded', 'paid']) : Promise.resolve({ data: [], error: null }),
  ]);
  const prof = new Map((profiles.data ?? []).map((p) => [p.id, p]));
  const wal = new Map((wallets.data ?? []).map((w) => [w.user_id, w]));
  return {
    sandbox: paymentProvider() === sandbox,
    provider: paymentProvider()?.name ?? null,
    withdrawalQueue: (queue.data ?? []).map((p) => {
      const mine = (totals.data ?? []).filter((t) => t.user_id === p.user_id);
      const sum = (dir: string) => mine.filter((t) => t.direction === dir).reduce((s, t) => s + Number(t.amount_cents), 0);
      return {
        ...p,
        email: emails.get(p.user_id as string) ?? p.user_id,
        profile: prof.get(p.user_id),
        wallet: wal.get(p.user_id),
        deposited_cents: sum('deposit'),
        withdrawn_cents: sum('withdrawal'),
      };
    }),
    recent: (recent.data ?? []).map((p) => ({ ...p, email: emails.get(p.user_id as string) ?? p.user_id })),
    reconciliation: recon.data ?? [],
  };
}

export class PaymentsOperatorError extends Error {}

export async function reviewWithdrawal(paymentId: string, approve: boolean, reason: string | undefined, by: string) {
  const { data: pay, error } = await db().rpc('review_withdrawal', { p_payment: paymentId, p_approve: approve, p_reason: reason ?? null, p_by: by });
  if (error) throw new PaymentsOperatorError(/already_reviewed/.test(error.message) ? 'That withdrawal was already reviewed.' : error.message);
  if (!approve) return;
  const provider = providers[pay.provider as string];
  if (!provider) throw new PaymentsOperatorError(`No payout connection for ${pay.provider}. The withdrawal is approved; pay it out manually.`);
  const { data: method } = await db().from('payment_methods').select('provider_token').eq('id', pay.method_id).single();
  const payout = await provider.createPayout({ paymentId, amountCents: Number(pay.amount_cents), methodToken: method!.provider_token as string });
  const { error: refErr } = await db().rpc('set_payment_ref', { p_payment: paymentId, p_ref: payout.providerRef });
  if (refErr) throw new PaymentsOperatorError(refErr.message);
  await payout.afterRefSaved?.();
}

/** Imports the processor's settlement report: from the provider if it offers one, else from CSV "ref,direction,amount_cents". */
export async function importSettlements(csv: string | undefined, by: string): Promise<number> {
  const provider = paymentProvider();
  let rows: { providerRef: string; direction: 'deposit' | 'withdrawal'; amountCents: number; settledAt?: string }[] = [];
  let providerName = provider?.name ?? 'manual';
  if (csv && csv.trim()) {
    const lines = csv.trim().split(/\r?\n/).filter((l) => l.trim() && !/^ref\b/i.test(l));
    rows = lines.map((l, i) => {
      const [ref, direction, amount] = l.split(',').map((x) => x.trim());
      if (!ref || !['deposit', 'withdrawal'].includes(direction) || !/^\d+$/.test(amount ?? ''))
        throw new PaymentsOperatorError(`Line ${i + 1}: expected "ref,deposit|withdrawal,amount_cents".`);
      return { providerRef: ref, direction: direction as 'deposit' | 'withdrawal', amountCents: Number(amount) };
    });
  } else if (provider?.settlementReport) {
    rows = await provider.settlementReport();
  } else throw new PaymentsOperatorError('Paste the processor’s settlement report as CSV: ref,direction,amount_cents.');
  if (!provider) providerName = 'manual';
  if (!rows.length) return 0;
  const { error } = await db()
    .from('provider_settlements')
    .upsert(
      rows.map((r) => ({ provider: providerName, provider_ref: r.providerRef, direction: r.direction, amount_cents: r.amountCents, settled_at: r.settledAt ?? null, imported_by: by })),
      { onConflict: 'provider,provider_ref,direction' },
    );
  if (error) throw new PaymentsOperatorError(error.message);
  return rows.length;
}

export async function simulateChargeback(paymentId: string) {
  if (paymentProvider() !== sandbox) throw new PaymentsOperatorError('Chargeback simulation only works with the sandbox processor.');
  const { data: pay } = await db().from('payments').select('provider_ref, amount_cents, status, direction').eq('id', paymentId).single();
  if (!pay || pay.direction !== 'deposit' || pay.status !== 'succeeded') throw new PaymentsOperatorError('Only a succeeded deposit can be charged back.');
  return sandbox.simulate('deposit.reversed', pay.provider_ref as string, Number(pay.amount_cents));
}
