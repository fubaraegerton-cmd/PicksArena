import { depositPOST } from '../../server/payments.js';

export function POST(request: Request) {
  return depositPOST(request);
}
