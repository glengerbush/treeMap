import { json } from '@sveltejs/kit';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  appDir, readCurrent, readStatus, isLockedByLiveProcess, listIncomingBundles
} from '$lib/server/update.js';

export function POST() {
  const current = join(appDir(), 'current');
  const r = spawnSync('git', ['-C', current, 'fetch', 'origin'], {
    encoding: 'utf8',
    timeout: 30000
  });
  const checkError = r.status === 0
    ? null
    : ((r.stderr || r.error?.message || `fetch failed (${r.status})`).trim() || 'fetch failed');
  return json({
    current: readCurrent(),
    running: isLockedByLiveProcess(),
    status: readStatus(),
    offlineBundles: listIncomingBundles(),
    checkError
  });
}
