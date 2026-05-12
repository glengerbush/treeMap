import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dataDir = join(process.cwd(), 'data');
const pidFile = join(dataDir, 'server.pid');
const maintenanceFlag = join(dataDir, 'maintenance.flag');

if (existsSync(maintenanceFlag)) {
  console.error('[hooks.server] maintenance flag present, exiting without serving');
  process.exit(0);
}

let pidWritten = false;

function writePidFile() {
  if (pidWritten) return;
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, `${process.pid}\n`);
  pidWritten = true;
}

function removePidFile() {
  if (!pidWritten) return;
  try {
    unlinkSync(pidFile);
  } catch {
    // file may already be gone (e.g. concurrent restart) — best-effort cleanup
  }
  pidWritten = false;
}

writePidFile();

process.on('exit', removePidFile);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    removePidFile();
    process.exit(0);
  });
}
