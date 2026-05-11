#!/usr/bin/env node
// scripts/migrate.mjs — Run pending data migrations from a release.
//
// Usage (CLI):
//   node scripts/migrate.mjs --release <dir> --data-dir <dir>
// Used programmatically by scripts/update.mjs.
//
// Migration files live at <release>/migrations/<id>.mjs and export:
//   export const id = '20260511-001-example';
//   export async function up({ dataDir, log }) { ... }
//
// Applied IDs are tracked in <data-dir>/migration-state.json. Migrations
// run in lex order of filename; an id mismatch between filename and the
// exported id aborts the run.

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const STATE_VERSION = 1;

function readState(stateFile) {
  if (!existsSync(stateFile)) return { version: STATE_VERSION, applied: [] };
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!Array.isArray(s.applied)) s.applied = [];
    return s;
  } catch (e) {
    throw new Error(`failed to parse ${stateFile}: ${e.message}`);
  }
}

function writeState(stateFile, state) {
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

function listMigrations(migrationsDir) {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir)
    .filter((f) => extname(f) === '.mjs' && !f.startsWith('.'))
    .sort();
}

export async function runMigrations({ releaseDir, dataDir, log = () => {} }) {
  const migrationsDir = join(releaseDir, 'migrations');
  const stateFile = join(dataDir, 'migration-state.json');

  mkdirSync(dataDir, { recursive: true });
  const state = readState(stateFile);
  const applied = new Set(state.applied.map((r) => r.id));
  const files = listMigrations(migrationsDir);

  const ran = [];
  for (const filename of files) {
    const expectedId = basename(filename, '.mjs');
    if (applied.has(expectedId)) continue;

    log(`[migrate] running ${expectedId}`);
    const mod = await import(pathToFileURL(join(migrationsDir, filename)).href);
    if (!mod.id || mod.id !== expectedId) {
      throw new Error(
        `migration ${filename}: exported id "${mod.id}" does not match filename`
      );
    }
    if (typeof mod.up !== 'function') {
      throw new Error(`migration ${filename}: missing 'up' export`);
    }

    await mod.up({ dataDir, log });

    state.applied.push({ id: expectedId, at: new Date().toISOString() });
    writeState(stateFile, state);
    ran.push(expectedId);
  }

  return { ran, total: files.length, alreadyApplied: applied.size };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--release' && argv[i + 1]) out.release = argv[++i];
    else if (argv[i] === '--data-dir' && argv[i + 1]) out.dataDir = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.release || !args.dataDir) {
    console.error('usage: migrate.mjs --release <dir> --data-dir <dir>');
    process.exit(2);
  }
  const result = await runMigrations({
    releaseDir: resolve(args.release),
    dataDir: resolve(args.dataDir),
    log: (m) => console.error(m)
  });
  console.log(JSON.stringify(result));
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error('[migrate] failed:', e.stack || e.message || e);
    process.exit(1);
  });
}
