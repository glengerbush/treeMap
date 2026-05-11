// scripts/_run.mjs — Shared spawnSync wrappers used by the update orchestrator.

import { spawnSync } from 'node:child_process';

export function runCapture(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${argv.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`
    );
  }
  return (r.stdout || '').trim();
}

export function runInherit(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})`);
}
