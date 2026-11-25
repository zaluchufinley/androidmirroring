// Sending files dropped on the window to the phone: APKs are installed, everything else goes to Downloads.

import path from 'node:path';
import { run } from './exec.js';
import { findAdb, ADB_MISSING } from './tools.js';

/** The last meaningful line adb printed, shortened. */
function reason(output) {
  const line = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? 'unknown error';
  return line.length > 110 ? line.slice(0, 110) + '…' : line;
}

/** `progress(text)` is called before each file. Resolves with { sentFiles, installedApps, failures }. */
export async function sendFiles(paths, serial, progress) {
  const r = { sentFiles: 0, installedApps: 0, failures: [] };
  const adb = findAdb();
  if (!adb) { r.failures.push(ADB_MISSING); return r; }
  for (const [i, file] of paths.entries()) {
    const name = path.basename(file);
    progress(paths.length > 1 ? `Sending ${i + 1} of ${paths.length}: ${name}` : `Sending ${name}…`);
    if (path.extname(file).toLowerCase() === '.apk') {
      const out = await run(adb, ['-s', serial, 'install', '-r', file]);
      if (out.status === 0 && out.out.includes('Success')) r.installedApps++;
      else r.failures.push(`${name}: ${reason(out.out)}`);
    } else {
      const out = await run(adb, ['-s', serial, 'push', file, '/sdcard/Download/']);
      if (out.status === 0) r.sentFiles++;
      else r.failures.push(`${name}: ${reason(out.out)}`);
    }
  }
  return r;
}

/** "Sent 2 files to Downloads · Installed 1 app" */
export function summary(r) {
  const parts = [];
  if (r.sentFiles > 0) parts.push(`Sent ${r.sentFiles} file${r.sentFiles === 1 ? '' : 's'} to Downloads`);
  if (r.installedApps > 0) parts.push(`Installed ${r.installedApps} app${r.installedApps === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
