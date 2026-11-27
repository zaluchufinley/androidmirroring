// Sending files dropped on the window to the phone: APKs are installed, everything else goes to Downloads.

import path from 'node:path';
import { run } from './exec.js';
import { findAdb, ADB_MISSING } from './tools.js';

/** The last meaningful line adb printed, shortened. */
function reason(output) {
  const line = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? 'unknown error';
  return line.length > 110 ? line.slice(0, 110) + '…' : line;
}

/** "a.pdf" -> "a (1).pdf", "notes" -> "notes (2)": the name to try when the phone already has the file. */
export function numberedName(name, n) {
  if (n === 0) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

// The phone's shell reads a file name, so quote it: '...' with each ' written as '\''
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

/** The first name in Downloads the phone does not have yet, so a drop never overwrites an existing file. */
async function freeName(adb, serial, name) {
  for (let n = 0; n < 100; n++) {
    const candidate = numberedName(name, n);
    const r = await run(adb, ['-s', serial, 'shell', `test -e ${quote('/sdcard/Download/' + candidate)}`], { timeout: 10_000 });
    if (r.status === 1) return candidate;  // exit 1 = "no such file"; anything else (adb trouble) falls through to a plain push
    if (r.status !== 0) break;
  }
  return name;
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
      const out = await run(adb, ['-s', serial, 'push', file, '/sdcard/Download/' + await freeName(adb, serial, name)]);
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
