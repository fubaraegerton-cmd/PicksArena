import { entriesPOST } from '../../server/rm.js';

export function POST(request: Request) {
  return entriesPOST(request);
}
