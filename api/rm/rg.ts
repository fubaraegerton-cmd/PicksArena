import { rgGET, rgPOST } from '../../server/rg.js';

export function GET(request: Request) {
  return rgGET(request);
}

export function POST(request: Request) {
  return rgPOST(request);
}
