import { personaWebhook } from '../../server/kyc.js';

export function POST(request: Request) {
  return personaWebhook(request);
}
