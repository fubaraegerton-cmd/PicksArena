import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { User } from '@supabase/supabase-js';
import { db } from './supabase.js';

/**
 * Identity verification (KYC). Provider is chosen with KYC_PROVIDER:
 *   persona — hosted document + selfie/liveness flow (PERSONA_API_KEY, PERSONA_TEMPLATE_ID,
 *             PERSONA_WEBHOOK_SECRET). Decisions arrive by signed webhook.
 *   manual  — no provider: requests go to the operator review queue. For testing and
 *             exceptional cases only; it does NOT check documents or liveness.
 *   (unset) — identity checks are off; starting one returns a clear "not connected" error.
 * Only decisions and a one-way identity hash are stored — never documents.
 * To add another provider (Jumio, Socure, Veriff…), implement KycProvider and a webhook
 * that calls applyProviderDecision().
 */

export interface KycStart {
  ref: string;
  /** Hosted verification page to send the player to, if the provider has one */
  url: string | null;
  status: 'pending' | 'review';
}

interface KycProvider {
  name: string;
  start(user: User): Promise<KycStart>;
}

const persona: KycProvider = {
  name: 'persona',
  async start(user) {
    const key = process.env.PERSONA_API_KEY!;
    const headers = {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'persona-version': '2023-01-05',
      'key-inflection': 'kebab',
    };
    const create = await fetch('https://api.withpersona.com/api/v1/inquiries', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: { attributes: { 'inquiry-template-id': process.env.PERSONA_TEMPLATE_ID, 'reference-id': user.id } },
      }),
    });
    if (!create.ok) throw new Error(`Identity provider error (${create.status}).`);
    const inquiry = (await create.json()) as { data: { id: string } };
    const link = await fetch(`https://api.withpersona.com/api/v1/inquiries/${inquiry.data.id}/generate-one-time-link`, {
      method: 'POST',
      headers,
    });
    if (!link.ok) throw new Error(`Identity provider error (${link.status}).`);
    const meta = ((await link.json()) as { meta?: Record<string, string> }).meta ?? {};
    return { ref: inquiry.data.id, url: meta['one-time-link'] ?? null, status: 'pending' };
  },
};

const manual: KycProvider = {
  name: 'manual',
  async start(user) {
    return { ref: `manual_${user.id}_${Date.now()}`, url: null, status: 'review' };
  },
};

export function kycProvider(): KycProvider | null {
  const p = process.env.KYC_PROVIDER;
  if (p === 'persona' && process.env.PERSONA_API_KEY && process.env.PERSONA_TEMPLATE_ID) return persona;
  if (p === 'manual') return manual;
  return null;
}

export interface KycRow {
  id: number;
  status: 'pending' | 'review' | 'approved' | 'rejected';
  provider: string;
  provider_ref: string | null;
  reason: string | null;
  created_at: string;
}

export async function latestKyc(userId: string): Promise<KycRow | null> {
  const { data, error } = await db()
    .from('kyc_records')
    .select('id, status, provider, provider_ref, reason, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as KycRow | null;
}

/** One-way identity fingerprint used to stop one person verifying several accounts. */
export function identityHash(first?: string, last?: string, dob?: string, idNumber?: string): string | null {
  if (!first || !last || !dob) return null;
  const norm = (s: string) => s.normalize('NFKD').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const salt = process.env.KYC_HASH_SALT ?? 'picksarena-kyc';
  return createHash('sha256').update(`${salt}|${norm(first)}|${norm(last)}|${dob}|${norm(idNumber ?? '')}`).digest('hex');
}

/** Applies a provider/operator decision through the database (duplicate identities are rejected there). */
export async function applyDecision(recordId: number, status: 'review' | 'approved' | 'rejected', reason: string | null, hash: string | null, by: string) {
  const { data, error } = await db().rpc('set_kyc_decision', {
    p_record: recordId,
    p_status: status,
    p_reason: reason,
    p_identity_hash: hash,
    p_decided_by: by,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/**
 * Verifies a Persona webhook: header "Persona-Signature: t=<unix>,v1=<hex>[ v1=<hex>]",
 * HMAC-SHA256 over "<t>.<raw body>". Rejects signatures older than 5 minutes (replay).
 */
export function verifyPersonaSignature(header: string | null, rawBody: string, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const parts = header.split(/[,\s]+/).map((p) => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

const PERSONA_STATUS: Record<string, 'approved' | 'rejected' | 'review'> = {
  approved: 'approved',
  declined: 'rejected',
  failed: 'rejected',
  expired: 'rejected',
  completed: 'review', // checks passed but not yet approved by the template's decisioning
  'needs-review': 'review',
  'marked-for-review': 'review',
};

/** POST /api/rm/kyc-webhook — Persona inquiry events. */
export async function personaWebhook(req: Request): Promise<Response> {
  const raw = await req.text();
  if (!verifyPersonaSignature(req.headers.get('persona-signature'), raw, process.env.PERSONA_WEBHOOK_SECRET ?? ''))
    return new Response('invalid signature', { status: 401 });
  let event: { data?: { attributes?: { name?: string; payload?: { data?: { id?: string; attributes?: Record<string, string> } } } } };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const inquiry = event.data?.attributes?.payload?.data;
  const attrs = inquiry?.attributes ?? {};
  const status = PERSONA_STATUS[attrs.status ?? ''] ?? PERSONA_STATUS[(event.data?.attributes?.name ?? '').replace('inquiry.', '')];
  if (!inquiry?.id || !status) return new Response('ignored', { status: 200 });

  const { data: rec } = await db().from('kyc_records').select('id, status').eq('provider', 'persona').eq('provider_ref', inquiry.id).maybeSingle();
  if (!rec) return new Response('unknown inquiry', { status: 200 }); // acknowledge so the provider stops retrying
  if (rec.status === 'approved' || rec.status === 'rejected') return new Response('already decided', { status: 200 });

  const hash = identityHash(attrs['name-first'], attrs['name-last'], attrs.birthdate, attrs['identification-number']);
  await applyDecision(rec.id, status, status === 'rejected' ? attrs.status ?? 'declined' : null, hash, 'persona-webhook');
  return new Response('ok', { status: 200 });
}
