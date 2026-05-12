#!/usr/bin/env node
// scripts/update.mjs — Apply a TreeMap update.
//
// Phase 3: online updates from origin/main with data migrations,
// snapshot+restore on failure, and a maintenance flag that holds the
// server down while migrations run. No auto-rollback on health failure
// yet (Phase 4 adds that).
//
// Usage:
//   node scripts/update.mjs [--app-dir <APP_DIR>]
// Env:
//   TREEMAP_APP_DIR  Same as --app-dir.
//
// Status snapshots land at data/update-status.json so the UI can poll
// across the restart that ends the update.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
  unlinkSync, symlinkSync, readlinkSync, renameSync, openSync, closeSync,
  readdirSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

// systemd services run with a minimal PATH (typically /usr/bin:/bin).
// When node lives elsewhere (nvm, /usr/local/bin, an asdf shim), the
// `npm` wrapper script exits 127 because its `#!/usr/bin/env node`
// can't find node. Prepend the running node's bin dir to PATH for any
// subprocess we spawn, so `npm` resolves the same node that's running us.
const NPM_PATH = `${dirname(process.execPath)}:${process.env.PATH || ''}`;
const NPM_ENV = { ...process.env, PATH: NPM_PATH };

import { runCapture, runInherit } from './_run.mjs';
import { runMigrations } from './migrate.mjs';
import { snapshotData, restoreSnapshot, pruneSnapshots } from './snapshot.mjs';

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
const MAINTENANCE = join(DATA, 'maintenance.flag');
const INCOMING = join(DATA, 'incoming');

function writeStatus(phase, extra = {}) {
  const status = { phase, updatedAt: new Date().toISOString(), ...extra };
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
  let holder;
  try { holder = parseInt(readFileSync(LOCK, 'utf8').trim(), 10); } catch { holder = NaN; }
  if (Number.isFinite(holder)) {
    try { process.kill(holder, 0); throw new Error(`update already running (pid ${holder})`); }
    catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
  writeFileSync(LOCK, String(process.pid));
}

function releaseLock() { try { unlinkSync(LOCK); } catch { /* best effort */ } }

function createMaintenanceFlag() { writeFileSync(MAINTENANCE, `${process.pid}\n`); }
function removeMaintenanceFlag() { try { unlinkSync(MAINTENANCE); } catch { /* fine */ } }

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const HEALTH_HOST = process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : '127.0.0.1';
const HEALTH_PORT = parseInt(process.env.PORT || '3000', 10);
const HEALTH_PATH = '/api/update/status';
const HEALTH_TIMEOUT_MS = 60000;
const HEALTH_INTERVAL_MS = 1000;
const HEALTH_REQ_TIMEOUT_MS = 2000;

async function probeHealth() {
  try {
    const res = await fetch(`http://${HEALTH_HOST}:${HEALTH_PORT}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(HEALTH_REQ_TIMEOUT_MS)
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(timeoutMs = HEALTH_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeHealth()) return true;
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  return false;
}

function killServerAndWait({ timeoutMs = 30000, pollMs = 200 } = {}) {
  if (!existsSync(PIDFILE)) return;
  let pid;
  try { pid = parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10); } catch { pid = NaN; }
  if (Number.isFinite(pid)) {
    try { process.kill(pid, 'SIGTERM'); }
    catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
  const start = Date.now();
  while (existsSync(PIDFILE) && Date.now() - start < timeoutMs) {
    sleepSync(pollMs);
  }
  if (existsSync(PIDFILE)) throw new Error('server did not stop within timeout');
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

function resolveUpdateSource() {
  if (!existsSync(INCOMING)) return { kind: 'origin' };
  const bundles = readdirSync(INCOMING)
    .filter((f) => f.endsWith('.bundle'))
    .sort()
    .map((f) => join(INCOMING, f));
  if (bundles.length === 0) return { kind: 'origin' };
  if (bundles.length > 1) {
    throw new Error(`multiple bundles in ${INCOMING}: ${bundles.map((b) => b.split('/').pop()).join(', ')}`);
  }
  return { kind: 'bundle', path: bundles[0] };
}

async function main() {
  mkdirSync(DATA, { recursive: true });

  acquireLock();
  process.on('exit', () => { releaseLock(); removeMaintenanceFlag(); });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { releaseLock(); removeMaintenanceFlag(); process.exit(1); });
  }

  const startedAt = new Date().toISOString();
  if (!existsSync(CURRENT)) throw new Error(`no current/ symlink at ${CURRENT}`);
  const fromSha = runCapture('git', ['-C', CURRENT, 'rev-parse', 'HEAD']);
  const fromVersion = readVersion(CURRENT);

  try {
    const source = resolveUpdateSource();
    writeStatus('fetching', { fromSha, fromVersion, source: source.kind });
    if (source.kind === 'bundle') {
      runCapture('git', ['-C', CURRENT, 'bundle', 'verify', source.path]);
      // Bundles can be created from any ref name (main, origin/main, ...).
      // Find which ref in the bundle represents main and fetch from that.
      const heads = runCapture('git', ['-C', CURRENT, 'bundle', 'list-heads', source.path]);
      const refs = heads.split('\n').map((line) => line.trim().split(/\s+/)[1]).filter(Boolean);
      const mainRef =
        refs.find((r) => r === 'refs/heads/main') ||
        refs.find((r) => r.endsWith('/main')) ||
        refs[0];
      if (!mainRef) throw new Error(`bundle ${source.path} has no refs`);
      runCapture('git', ['-C', CURRENT, 'fetch', source.path, `${mainRef}:refs/remotes/origin/main`]);
    } else {
      runCapture('git', ['-C', CURRENT, 'fetch', 'origin']);
    }
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
    // --include=dev: the systemd unit sets NODE_ENV=production, which
    // npm ci would otherwise treat as a signal to skip devDependencies.
    // SvelteKit's build needs vite + @sveltejs/kit + svelte from devDeps.
    runInherit('npm', ['ci', '--include=dev'], { cwd: newRelease, env: NPM_ENV });
    runInherit('npm', ['run', 'build'], { cwd: newRelease, env: NPM_ENV });
    const toVersion = readVersion(newRelease);

    writeStatus('stopping', { fromSha, toSha, fromVersion, toVersion });
    createMaintenanceFlag();
    killServerAndWait();

    let snapshotPath = null;
    let oldTarget = null;
    let swapped = false;
    try {
      writeStatus('snapshotting', { fromSha, toSha, fromVersion, toVersion });
      snapshotPath = snapshotData({ dataDir: DATA, label: `pre-${toVersion}` });

      writeStatus('migrating', { fromSha, toSha, fromVersion, toVersion });
      const migrated = await runMigrations({
        releaseDir: newRelease,
        dataDir: DATA,
        log: (m) => console.error(m)
      });

      writeStatus('swapping', { fromSha, toSha, fromVersion, toVersion, migrated: migrated.ran });
      oldTarget = readlinkSync(CURRENT);
      atomicSymlink(oldTarget, PREVIOUS);
      atomicSymlink(`releases/${shortTo}`, CURRENT);
      swapped = true;
      // Bundle has served its purpose. Consume it so the next update
      // doesn't redundantly try to apply the same one.
      if (source.kind === 'bundle') {
        try { unlinkSync(source.path); } catch { /* best effort */ }
      }
    } catch (e) {
      // Pre-swap failure (snapshot/migration). Restore data; old code is
      // still pointed at by `current` so removing the flag brings it back.
      if (snapshotPath) {
        try { restoreSnapshot({ dataDir: DATA, snapshotPath }); }
        catch (re) {
          appendLog({
            at: new Date().toISOString(), outcome: 'restore-failed',
            snapshot: snapshotPath, error: re.message || String(re)
          });
        }
      }
      removeMaintenanceFlag();
      throw e;
    }

    // Swap done. Let systemd respawn the new code, then probe.
    writeStatus('restarting', { fromSha, toSha, fromVersion, toVersion });
    removeMaintenanceFlag();

    writeStatus('verifying', { fromSha, toSha, fromVersion, toVersion });
    const healthy = await waitForHealthy();

    if (!healthy) {
      // Rollback. Block respawns, take down the unhealthy new server,
      // restore data, swap symlinks back to the old release.
      writeStatus('rolling-back', { fromSha, toSha, fromVersion, toVersion });
      createMaintenanceFlag();
      try {
        killServerAndWait();
        try { restoreSnapshot({ dataDir: DATA, snapshotPath }); }
        catch (re) {
          appendLog({
            at: new Date().toISOString(), outcome: 'restore-failed',
            snapshot: snapshotPath, error: re.message || String(re)
          });
        }
        if (swapped && oldTarget) {
          atomicSymlink(oldTarget, CURRENT);
          try { unlinkSync(PREVIOUS); } catch { /* fine */ }
        }
      } finally {
        removeMaintenanceFlag();
      }
      // Best-effort: confirm the old code comes back up.
      const recovered = await waitForHealthy(30000);
      writeStatus('rolled-back', { fromSha, toSha, fromVersion, toVersion, recovered });
      appendLog({
        at: startedAt, outcome: 'rolled-back',
        from: fromSha, to: toSha, fromVersion, toVersion, recovered
      });
      return;
    }

    pruneSnapshots({ dataDir: DATA, keep: 3 });
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
