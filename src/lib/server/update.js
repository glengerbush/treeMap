import { existsSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export function appDir() {
  return resolve(process.env.TREEMAP_APP_DIR || process.cwd());
}

function paths() {
  const root = appDir();
  return {
    root,
    current: join(root, 'current'),
    data: join(root, 'data'),
    status: join(root, 'data', 'update-status.json'),
    lock: join(root, 'data', 'update.lock'),
    log: join(root, 'data', 'update-log.jsonl'),
    updateScript: join(root, 'current', 'scripts', 'update.mjs')
  };
}

function tryGit(cwd, argv) {
  const r = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

export function readCurrent() {
  const p = paths();
  if (!existsSync(p.current)) return null;
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(p.current, 'package.json'), 'utf8')).version;
  } catch { /* fall through */ }
  const sha = tryGit(p.current, ['rev-parse', 'HEAD']);
  const target = tryGit(p.current, ['rev-parse', 'origin/main']);
  let targetVersion = null;
  if (target && target !== sha) {
    const out = tryGit(p.current, ['show', `origin/main:package.json`]);
    if (out) {
      try { targetVersion = JSON.parse(out).version; } catch { /* ignore */ }
    }
  }
  return {
    version,
    sha,
    targetSha: target,
    targetVersion,
    updateAvailable: !!target && target !== sha
  };
}

export function readStatus() {
  const p = paths();
  if (!existsSync(p.status)) return null;
  try { return JSON.parse(readFileSync(p.status, 'utf8')); }
  catch { return null; }
}

export function isLockedByLiveProcess() {
  const p = paths();
  if (!existsSync(p.lock)) return false;
  let pid;
  try { pid = parseInt(readFileSync(p.lock, 'utf8').trim(), 10); }
  catch { return false; }
  if (!Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

export function lastLogEntries(limit = 20) {
  const p = paths();
  if (!existsSync(p.log)) return [];
  const lines = readFileSync(p.log, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
}

export function updateScriptPath() {
  return paths().updateScript;
}
