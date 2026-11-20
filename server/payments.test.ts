import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature, webhookPOST } from './payments';

describe('payment webhook signatures', () => {
  const now = 1_800_000_000_000;
  it('round-trips and rejects tampering, wrong secret and replays', () => {
    const body = '{"id":"evt_1","type":"deposit.succeeded"}';
    const sig = signPayload(body, 's3cret', now);
    expect(verifySignature(sig, body, 's3cret', now)).toBe(true);
    expect(verifySignature(sig, body.replace('evt_1', 'evt_2'), 's3cret', now)).toBe(false);
    expect(verifySignature(sig, body, 'other', now)).toBe(false);
    expect(verifySignature(sig, body, 's3cret', now + 301_000)).toBe(false);
    expect(verifySignature(null, body, 's3cret', now)).toBe(false);
  });

  it('the webhook endpoint refuses unsigned or forged events before touching the database', async () => {
    const forged = new Request('http://x/api/pay/webhook?provider=sandbox', {
      method: 'POST',
      headers: { 'sandbox-signature': signPayload('{"id":"evt","type":"deposit.succeeded"}', 'not-the-secret') },
      body: '{"id":"evt","type":"deposit.succeeded","data":{"ref":"r","amount_cents":100000}}',
    });
    expect((await webhookPOST(forged)).status).toBe(401);
    const unknown = new Request('http://x/api/pay/webhook?provider=nope', { method: 'POST', body: '{}' });
    expect((await webhookPOST(unknown)).status).toBe(404);
  });
});
