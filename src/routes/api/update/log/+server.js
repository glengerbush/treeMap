import { json } from '@sveltejs/kit';
import { lastLogEntries } from '$lib/server/update.js';

export function GET({ url }) {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 200);
  return json({ entries: lastLogEntries(limit) });
}
