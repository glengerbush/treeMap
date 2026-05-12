// scripts/snapshot.mjs — Snapshot, restore, and prune the shared data/ dir.
//
// Snapshots live at <dataDir>/snapshots/<id>/ where <id> is a sortable
// timestamp + label. Pure-Node copy via fs.cpSync; no external binaries.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Top-level entries in data/ that are per-process state, not user data.
// Skipped on both snapshot and restore so neither operation touches them.
const EXCLUDES = new Set([
  'snapshots',
  'update.lock',
  'update-status.json',
  'update.log',
  'server.pid',
  'maintenance.flag'
]);

function topLevelName(root, p) {
  const rel = relative(root, p);
  if (!rel || rel.startsWith('..')) return null;
  return rel.split(sep)[0];
}

function makeFilter(root) {
  return (src) => {
    const top = topLevelName(root, src);
    return top === null || !EXCLUDES.has(top);
  };
}

export function snapshotsDir(dataDir) {
  return join(dataDir, 'snapshots');
}

export function snapshotData({ dataDir, label }) {
  mkdirSync(snapshotsDir(dataDir), { recursive: true });
  const safeLabel = (label || 'snapshot').replace(/[^A-Za-z0-9._-]/g, '_');
  const id = `${timestamp()}-${safeLabel}`;
  const target = join(snapshotsDir(dataDir), id);

  cpSync(dataDir, target, {
    recursive: true,
    preserveTimestamps: true,
    filter: makeFilter(dataDir)
  });
  return target;
}

export function restoreSnapshot({ dataDir, snapshotPath }) {
  if (!existsSync(snapshotPath)) throw new Error(`snapshot missing: ${snapshotPath}`);

  // --delete equivalent: wipe non-excluded top-level entries before copying back.
  for (const name of readdirSync(dataDir)) {
    if (EXCLUDES.has(name)) continue;
    rmSync(join(dataDir, name), { recursive: true, force: true });
  }

  cpSync(snapshotPath, dataDir, {
    recursive: true,
    preserveTimestamps: true,
    filter: makeFilter(snapshotPath)
  });
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
