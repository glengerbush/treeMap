import { json } from '@sveltejs/kit';
import { readCurrent, readStatus, isLockedByLiveProcess } from '$lib/server/update.js';

export function GET() {
  return json({
    current: readCurrent(),
    running: isLockedByLiveProcess(),
    status: readStatus()
  });
}
