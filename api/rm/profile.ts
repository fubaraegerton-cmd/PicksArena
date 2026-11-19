import { profileGET, profilePOST } from '../../server/rm.js';

export function GET(request: Request) {
  return profileGET(request);
}

export function POST(request: Request) {
  return profilePOST(request);
}
