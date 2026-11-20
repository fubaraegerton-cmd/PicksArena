import { withdrawCancelPOST } from '../../server/payments.js';

export function POST(request: Request) {
  return withdrawCancelPOST(request);
}
