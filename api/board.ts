import { boardGET } from '../server/handlers.js';
import { scoresGET } from '../server/feed.js';

// Scores share this function: the Vercel Hobby plan allows 12 functions.
export function GET(request: Request) {
  if (new URL(request.url).searchParams.get('view') === 'scores') return scoresGET();
  return boardGET();
}
