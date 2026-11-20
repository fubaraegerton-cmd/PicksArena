import { webhookPOST } from '../../server/payments.js';

export function POST(request: Request) {
  return webhookPOST(request);
}
