import { afterEach, describe, expect, it } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { isOperatorUser } from './console';

const u = (over: Partial<User>): User => ({ id: 'x', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '', ...over }) as User;

describe('operator access', () => {
  afterEach(() => {
    delete process.env.OPERATOR_EMAILS;
  });
  it('grants by server-set role', () => {
    expect(isOperatorUser(u({ app_metadata: { role: 'operator' } }))).toBe(true);
    expect(isOperatorUser(u({ user_metadata: { role: 'operator' } }))).toBe(false); // players can edit user_metadata
  });
  it('grants listed emails only once the email is confirmed', () => {
    process.env.OPERATOR_EMAILS = 'Owner@Example.com, ops@example.com';
    expect(isOperatorUser(u({ email: 'owner@example.com', email_confirmed_at: '2026-01-01' }))).toBe(true);
    expect(isOperatorUser(u({ email: 'owner@example.com' }))).toBe(false);
    expect(isOperatorUser(u({ email: 'someone@example.com', email_confirmed_at: '2026-01-01' }))).toBe(false);
    expect(isOperatorUser(null)).toBe(false);
  });
});
