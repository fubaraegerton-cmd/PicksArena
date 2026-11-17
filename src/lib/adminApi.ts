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
  let res: Response;
  try {
    res = await fetch('/api/admin', {
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
