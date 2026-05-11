import { json, error } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { openSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { appDir, updateScriptPath, isLockedByLiveProcess } from '$lib/server/update.js';

export function POST() {
  if (isLockedByLiveProcess()) {
    error(409, 'update already in progress');
  }

  const root = appDir();
  const script = updateScriptPath();
  if (!existsSync(script)) {
    error(500, `update script missing at ${script}`);
  }

  const logPath = join(root, 'data', 'update.log');
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [script, '--app-dir', root], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: root,
    env: { ...process.env, TREEMAP_APP_DIR: root }
  });
  child.unref();

  return json({ started: true, pid: child.pid }, { status: 202 });
}
