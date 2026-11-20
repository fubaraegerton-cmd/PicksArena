import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { identityHash, verifyPersonaSignature } from './kyc';

const secret = 'whsec_test';
const body = JSON.stringify({ data: { attributes: { name: 'inquiry.approved' } } });
const sign = (t: number, b = body, s = secret) => `t=${t},v1=${createHmac('sha256', s).update(`${t}.${b}`).digest('hex')}`;

describe('Persona webhook signature', () => {
  const now = 1_800_000_000_000;
  const t = now / 1000;
  it('accepts a valid, fresh signature', () => {
    expect(verifyPersonaSignature(sign(t), body, secret, now)).toBe(true);
  });
  it('accepts when one of several signatures matches (secret rotation)', () => {
    const h = `t=${t},v1=${'0'.repeat(64)} v1=${sign(t).split('v1=')[1]}`;
    expect(verifyPersonaSignature(h, body, secret, now)).toBe(true);
  });
  it('rejects a tampered body, wrong secret, stale timestamp or missing header', () => {
    expect(verifyPersonaSignature(sign(t), body.replace('approved', 'declined'), secret, now)).toBe(false);
    expect(verifyPersonaSignature(sign(t, body, 'other'), body, secret, now)).toBe(false);
    expect(verifyPersonaSignature(sign(t - 301), body, secret, now)).toBe(false);
    expect(verifyPersonaSignature(null, body, secret, now)).toBe(false);
    expect(verifyPersonaSignature(sign(t), body, '', now)).toBe(false);
  });
});

describe('identity hash', () => {
  it('is stable across case, accents and punctuation', () => {
    expect(identityHash('José', "O'Neil", '1990-01-02')).toBe(identityHash('JOSE', 'oneil', '1990-01-02'));
  });
  it('differs for different people and needs name + DOB', () => {
    expect(identityHash('Ana', 'Lee', '1990-01-02')).not.toBe(identityHash('Ana', 'Lee', '1990-01-03'));
    expect(identityHash('Ana', undefined, '1990-01-02')).toBeNull();
  });
});
