// scripts/snapshot.mjs — Snapshot, restore, and prune the shared data/ dir.
//
// Snapshots live at <dataDir>/snapshots/<id>/ where <id> is a sortable
// timestamp + label. Pure-Node copy via fs.cpSync; no external binaries.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Top-level entries in data/ that are per-process state, not user data.
// Skipped on both snapshot and restore so neither operation touches them.
// Iterating entries (rather than using cpSync's filter) sidesteps the
// "dest is subdirectory of src" check that fires when snapshots/ lives
// inside data/.
const EXCLUDES = new Set([
  'snapshots',
  'update.lock',
  'update-status.json',
  'update.log',
  'server.pid',
  'maintenance.flag'
]);

export function snapshotsDir(dataDir) {
  return join(dataDir, 'snapshots');
}

function copyEntries(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    if (EXCLUDES.has(name)) continue;
    cpSync(join(srcDir, name), join(dstDir, name), {
      recursive: true,
      preserveTimestamps: true
    });
  }
}

export function snapshotData({ dataDir, label }) {
  mkdirSync(snapshotsDir(dataDir), { recursive: true });
  const safeLabel = (label || 'snapshot').replace(/[^A-Za-z0-9._-]/g, '_');
  const id = `${timestamp()}-${safeLabel}`;
  const target = join(snapshotsDir(dataDir), id);
  copyEntries(dataDir, target);
  return target;
}

export function restoreSnapshot({ dataDir, snapshotPath }) {
  if (!existsSync(snapshotPath)) throw new Error(`snapshot missing: ${snapshotPath}`);

  // --delete equivalent: wipe non-excluded top-level entries before restoring.
  for (const name of readdirSync(dataDir)) {
    if (EXCLUDES.has(name)) continue;
    rmSync(join(dataDir, name), { recursive: true, force: true });
  }

  copyEntries(snapshotPath, dataDir);
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
