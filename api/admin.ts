import { adminGET, adminPOST } from '../server/handlers.js';

export function GET(request: Request) {
  return adminGET(request);
}

export function POST(request: Request) {
  return adminPOST(request);
}
