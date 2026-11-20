import { withdrawPOST } from '../../server/payments.js';

export function POST(request: Request) {
  return withdrawPOST(request);
}
