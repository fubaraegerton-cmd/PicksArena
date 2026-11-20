import { sandboxCheckoutPOST } from '../../server/payments.js';

export function POST(request: Request) {
  return sandboxCheckoutPOST(request);
}
