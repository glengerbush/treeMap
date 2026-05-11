#!/usr/bin/env node
// scripts/update.mjs — Apply a TreeMap update.
//
// Phase 2: online updates from origin/main with atomic symlink swap.
// No data migrations and no auto-rollback yet (added in later phases).
//
// Usage:
//   node scripts/update.mjs [--app-dir <APP_DIR>]
// Env:
//   TREEMAP_APP_DIR  Same as --app-dir.
//
// The script is meant to be spawned detached by the running server. It
// writes JSON snapshots to data/update-status.json so the web UI can
// poll across the restart that ends the update.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
  unlinkSync, symlinkSync, readlinkSync, renameSync, openSync, closeSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app-dir' && argv[i + 1]) { out.appDir = argv[++i]; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const APP_DIR = resolve(args.appDir || process.env.TREEMAP_APP_DIR || process.cwd());
const DATA = join(APP_DIR, 'data');
const RELEASES = join(APP_DIR, 'releases');
const CURRENT = join(APP_DIR, 'current');
const PREVIOUS = join(APP_DIR, 'previous');
const LOCK = join(DATA, 'update.lock');
const STATUS = join(DATA, 'update-status.json');
const LOG = join(DATA, 'update-log.jsonl');
const PIDFILE = join(DATA, 'server.pid');

function writeStatus(phase, extra = {}) {
  const status = { phase, updatedAt: new Date().toISOString(), pid: process.pid, ...extra };
  writeFileSync(STATUS, JSON.stringify(status, null, 2) + '\n');
}

function appendLog(record) {
  appendFileSync(LOG, JSON.stringify(record) + '\n');
}

function acquireLock() {
  try {
    const fd = openSync(LOCK, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  // Existing lock — check whether the holder is still alive.
  let holder;
  try { holder = parseInt(readFileSync(LOCK, 'utf8').trim(), 10); } catch { holder = NaN; }
  if (Number.isFinite(holder)) {
    try { process.kill(holder, 0); throw new Error(`update already running (pid ${holder})`); }
    catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
  writeFileSync(LOCK, String(process.pid));
}

function releaseLock() { try { unlinkSync(LOCK); } catch { /* best effort */ } }

function runCapture(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

function runInherit(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})`);
}

function readVersion(releaseDir) {
  return JSON.parse(readFileSync(join(releaseDir, 'package.json'), 'utf8')).version;
}

function atomicSymlink(target, linkPath) {
  const tmp = `${linkPath}.new`;
  try { unlinkSync(tmp); } catch { /* fine */ }
  symlinkSync(target, tmp);
  renameSync(tmp, linkPath);
}

async function main() {
  mkdirSync(DATA, { recursive: true });

  acquireLock();
  process.on('exit', releaseLock);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { releaseLock(); process.exit(1); });
  }

  const startedAt = new Date().toISOString();
  if (!existsSync(CURRENT)) throw new Error(`no current/ symlink at ${CURRENT}`);
  const fromSha = runCapture('git', ['-C', CURRENT, 'rev-parse', 'HEAD']);
  const fromVersion = readVersion(CURRENT);

  try {
    writeStatus('fetching', { fromSha, fromVersion });
    runCapture('git', ['-C', CURRENT, 'fetch', 'origin']);
    const toSha = runCapture('git', ['-C', CURRENT, 'rev-parse', 'origin/main']);

    if (toSha === fromSha) {
      writeStatus('noop', { fromSha, fromVersion, message: 'already up to date' });
      appendLog({ at: startedAt, outcome: 'noop', from: fromSha, to: toSha });
      return;
    }

    const shortTo = toSha.slice(0, 12);
    const newRelease = join(RELEASES, shortTo);

    writeStatus('staging', { fromSha, toSha, target: shortTo });
    if (!existsSync(newRelease)) {
      runCapture('git', ['clone', '--local', '--no-hardlinks', CURRENT, newRelease]);
      runCapture('git', ['-C', newRelease, 'checkout', toSha]);
      const origin = runCapture('git', ['-C', CURRENT, 'remote', 'get-url', 'origin']);
      runCapture('git', ['-C', newRelease, 'remote', 'set-url', 'origin', origin]);
    }

    writeStatus('building', { fromSha, toSha, target: shortTo });
    runInherit('npm', ['ci'], { cwd: newRelease });
    runInherit('npm', ['run', 'build'], { cwd: newRelease });

    writeStatus('swapping', { fromSha, toSha });
    const oldTarget = readlinkSync(CURRENT);
    atomicSymlink(oldTarget, PREVIOUS);
    atomicSymlink(`releases/${shortTo}`, CURRENT);

    const toVersion = readVersion(newRelease);

    writeStatus('restarting', { fromSha, toSha, fromVersion, toVersion });
    if (existsSync(PIDFILE)) {
      const serverPid = parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10);
      if (Number.isFinite(serverPid)) {
        try { process.kill(serverPid, 'SIGTERM'); }
        catch (err) { if (err.code !== 'ESRCH') throw err; }
      }
    }

    writeStatus('done', { fromSha, toSha, fromVersion, toVersion });
    appendLog({ at: startedAt, outcome: 'success', from: fromSha, to: toSha, fromVersion, toVersion });
  } catch (e) {
    const msg = e.message || String(e);
    writeStatus('failed', { fromSha, fromVersion, error: msg });
    appendLog({ at: startedAt, outcome: 'failed', from: fromSha, error: msg });
    throw e;
  }
}

main().catch((e) => {
  console.error('[update] failed:', e.stack || e.message || e);
  process.exit(1);
});
