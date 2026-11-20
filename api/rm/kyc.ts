import { kycGET, kycPOST } from '../../server/rm.js';

export function GET(request: Request) {
  return kycGET(request);
}

export function POST(request: Request) {
  return kycPOST(request);
}
