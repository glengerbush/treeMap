// scripts/snapshot.mjs — Snapshot, restore, and prune the shared data/ dir.
//
// Snapshots live at <dataDir>/snapshots/<id>/ where <id> is a sortable
// timestamp + label. rsync handles the copy/restore so we can exclude
// snapshots/ from itself and benefit from --delete on restore.

import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
  }
}

export function snapshotsDir(dataDir) {
  return join(dataDir, 'snapshots');
}

export function snapshotData({ dataDir, label }) {
  mkdirSync(snapshotsDir(dataDir), { recursive: true });
  const safeLabel = (label || 'snapshot').replace(/[^A-Za-z0-9._-]/g, '_');
  const id = `${timestamp()}-${safeLabel}`;
  const target = join(snapshotsDir(dataDir), id);

  // rsync trailing slash on source = copy CONTENTS of dataDir.
  // Exclude snapshots/ so we don't recursively copy ourselves.
  run('rsync', [
    '-a',
    '--exclude=snapshots/',
    '--exclude=update.lock',
    '--exclude=update-status.json',
    '--exclude=update.log',
    '--exclude=server.pid',
    '--exclude=maintenance.flag',
    `${dataDir.replace(/\/?$/, '/')}`,
    `${target}/`
  ]);
  return target;
}

export function restoreSnapshot({ dataDir, snapshotPath }) {
  if (!existsSync(snapshotPath)) throw new Error(`snapshot missing: ${snapshotPath}`);
  // Delete extraneous files in dataDir that aren't in the snapshot — but
  // never touch the snapshots dir itself (rsync --delete-excluded would
  // wipe it; --exclude alone keeps it intact).
  run('rsync', [
    '-a',
    '--delete',
    '--exclude=snapshots/',
    '--exclude=update.lock',
    '--exclude=update-status.json',
    '--exclude=update.log',
    '--exclude=server.pid',
    '--exclude=maintenance.flag',
    `${snapshotPath.replace(/\/?$/, '/')}`,
    `${dataDir.replace(/\/?$/, '/')}`
  ]);
}

export function pruneSnapshots({ dataDir, keep = 3 }) {
  const dir = snapshotsDir(dataDir);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir)
    .filter((name) => {
      try { return statSync(join(dir, name)).isDirectory(); }
      catch { return false; }
    })
    .sort(); // lex sort works because timestamp prefix is sortable

  const removed = [];
  while (entries.length > keep) {
    const oldest = entries.shift();
    const target = join(dir, oldest);
    rmSync(target, { recursive: true, force: true });
    removed.push(oldest);
  }
  return removed;
}
