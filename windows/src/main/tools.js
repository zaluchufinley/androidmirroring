// Finds adb and the scrcpy server jar, and the scrcpy version the jar must be started with.
//
// Order: environment override -> the copy bundled in the installer (resources/bin) -> PATH -> well-known folders.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from './exec.js';

const isWin = process.platform === 'win32';
const here = path.dirname(fileURLToPath(import.meta.url));

function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function firstExisting(paths) {
  return paths.filter(Boolean).find(exists) ?? null;
}

/** Folder holding the tools shipped with the app. */
export function bundledDir() {
  // Packaged: <install>/resources/bin. Development: windows/resources/bin (filled by `npm run fetch-tools`).
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null;
  const dev = path.join(here, '..', '..', 'resources', 'bin');
  return [packaged, dev].filter(Boolean).find((d) => exists(path.join(d, isWin ? 'adb.exe' : 'adb')) || exists(path.join(d, 'scrcpy-server'))) ?? dev;
}

function onPath(name) {
  const file = isWin ? `${name}.exe` : name;  // spawn() needs a real executable, so .cmd/.bat shims don't count
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ''), file);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function wellKnown(name) {
  const home = os.homedir();
  const exe = isWin ? `${name}.exe` : name;
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const dirs = isWin
    ? [
        local && path.join(local, 'Android', 'Sdk', 'platform-tools'),
        pf && path.join(pf, 'scrcpy'),
        path.join(home, 'scoop', 'apps', name, 'current'),
        path.join(home, 'scoop', 'apps', 'scrcpy', 'current'),
        path.join(home, 'scoop', 'shims'),
        'C:\\ProgramData\\chocolatey\\bin',
      ]
    : ['/opt/homebrew/bin', '/usr/local/bin'];  // development on macOS
  return firstExisting(dirs.filter(Boolean).map((d) => path.join(d, exe)));
}

export function findAdb() {
  return firstExisting([process.env.AM_ADB, path.join(bundledDir(), isWin ? 'adb.exe' : 'adb')])
    ?? onPath('adb') ?? wellKnown('adb');
}

function findScrcpy() {
  return firstExisting([process.env.AM_SCRCPY]) ?? onPath('scrcpy') ?? wellKnown('scrcpy');
}

export function findServerJar() {
  const scrcpy = findScrcpy();
  const beside = scrcpy && [
    path.join(path.dirname(scrcpy), 'scrcpy-server'),
    path.join(path.dirname(scrcpy), '..', 'share', 'scrcpy', 'scrcpy-server'),
  ];
  return firstExisting([
    process.env.SCRCPY_SERVER_PATH,
    process.env.AM_SCRCPY_SERVER,
    path.join(bundledDir(), 'scrcpy-server'),
    ...(beside ?? []),
    '/opt/homebrew/share/scrcpy/scrcpy-server',
    '/usr/local/share/scrcpy/scrcpy-server',
  ]);
}

let versionCache = null;

/** The server refuses to run unless this matches its own version exactly. */
export async function scrcpyVersion() {
  if (versionCache) return versionCache;
  if (process.env.AM_SCRCPY_VERSION) return (versionCache = process.env.AM_SCRCPY_VERSION);
  const bundled = path.join(bundledDir(), 'VERSION');
  if (exists(bundled)) {
    const v = fs.readFileSync(bundled, 'utf8').trim();
    if (v) return (versionCache = v);
  }
  const scrcpy = findScrcpy();
  if (scrcpy) {
    const line = (await run(scrcpy, ['--version'], { timeout: 10_000 })).out.split(/\r?\n/)[0] ?? '';
    const parts = line.split(' ');
    if (parts.length >= 2 && /^\d/.test(parts[1])) return (versionCache = parts[1]);
  }
  return '0';
}

export const ADB_MISSING =
  'adb was not found. Reinstall the app, or install Android platform-tools and add it to PATH.';
export const SERVER_MISSING =
  'scrcpy-server was not found. Reinstall the app, or install scrcpy and add it to PATH.';
