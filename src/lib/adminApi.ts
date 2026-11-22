import type { AdminAction, AdminData } from '../shared/admin';

const PASS_KEY = 'picksarena:admin-pass';

export class AdminError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: AdminData,
  ) {
    super(message);
  }
}

export function savedPassword(): string | null {
  try {
    return sessionStorage.getItem(PASS_KEY);
  } catch {
    return null;
  }
}

export function rememberPassword(p: string | null) {
  try {
    if (p) sessionStorage.setItem(PASS_KEY, p);
    else sessionStorage.removeItem(PASS_KEY);
  } catch {
    /* ignore */
  }
}

async function call<T>(password: string, init?: RequestInit): Promise<T> {
  return callAt<T>('/api/admin', password, init);
}

async function callAt<T>(url: string, password: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${password}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    throw new AdminError('Can’t reach the server. Check your connection.', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AdminError(body.error ?? `Request failed (${res.status})`, res.status, body.data);
  return body as T;
}

export function adminLogin(password: string) {
  return call<{ data: AdminData; storage: 'blob' | 'file' | 'none' }>(password);
}

export function adminDo(password: string, action: AdminAction, baseVersion: number) {
  return call<{ data: AdminData }>(password, { method: 'POST', body: JSON.stringify({ ...action, baseVersion }) });
}

export interface ComplianceData {
  jurisdictions: { state: string; name: string; enabled: boolean; min_age: number; updated_at: string; updated_by: string | null }[];
  countries?: { code: string; name: string; enabled: boolean; min_age: number }[];
  kycQueue: { id: number; user_id: string; email: string; provider: string; status: string; created_at: string }[];
  flagged: { id: string; email: string; state: string | null; kyc_status: string; flags: Record<string, unknown> }[];
  geoDenials: { id: number; email: string; action: string; region: string | null; country: string | null; is_vpn: boolean | null; reason: string | null; created_at: string }[];
}

export function adminCompliance(credential: string) {
  return callAt<ComplianceData>('/api/admin?view=compliance', credential);
}

export function adminCompliancePost(credential: string, body: Record<string, unknown>) {
  return callAt<{ ok: true; compliance: ComplianceData }>('/api/admin', credential, { method: 'POST', body: JSON.stringify(body) });
}

export interface PaymentsData {
  sandbox: boolean;
  provider: string | null;
  withdrawalQueue: {
    id: string;
    email: string;
    amount_cents: number;
    created_at: string;
    payment_methods: { label: string; status: string } | null;
    profile?: { kyc_status: string; state: string | null; flags: Record<string, unknown> };
    wallet?: { available_cents: number; held_cents: number };
    deposited_cents: number;
    withdrawn_cents: number;
  }[];
  recent: { id: string; email: string; direction: string; amount_cents: number; status: string; provider: string; provider_ref: string | null; failure_reason: string | null; created_at: string; reviewed_by: string | null }[];
  reconciliation: { issue: string; payment_id: string | null; provider: string; provider_ref: string; ours_cents: number | null; theirs_cents: number | null }[];
  pendingDeposits: { id: string; email: string; amount_cents: number; provider: string; provider_ref: string | null; created_at: string }[];
}

export function adminPayments(credential: string) {
  return callAt<PaymentsData>('/api/admin?view=payments', credential);
}

export function adminPaymentsPost(credential: string, body: Record<string, unknown>) {
  return callAt<{ ok: true; note: string; payments: PaymentsData }>('/api/admin', credential, { method: 'POST', body: JSON.stringify(body) });
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  subject: string | null;
  details: Record<string, unknown>;
}

export function adminAudit(credential: string, action = '', email = '') {
  const q = new URLSearchParams({ view: 'audit' });
  if (action) q.set('action', action);
  if (email) q.set('email', email);
  return callAt<{ rows: AuditRow[] }>(`/api/admin?${q}`, credential);
}

/** Generic operator calls used by the console (phase 6). */
export function adminView<T>(credential: string, params: Record<string, string>) {
  return callAt<T>(`/api/admin?${new URLSearchParams(params)}`, credential);
}
export function adminAction<T = { ok: true }>(credential: string, body: Record<string, unknown>) {
  return callAt<T>('/api/admin', credential, { method: 'POST', body: JSON.stringify(body) });
}
