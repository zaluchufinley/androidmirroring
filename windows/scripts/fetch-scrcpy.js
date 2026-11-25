// Downloads the pinned scrcpy release for Windows and unpacks the few files the app needs (adb and the server jar)
// into resources/bin, which the installer ships. The download is checked against the release's SHA256SUMS.txt.
//
//   node scripts/fetch-scrcpy.js [--arch x64|arm64] [--force]
//
// The version must match the server jar it ships with, so it is written to resources/bin/VERSION.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SCRCPY_VERSION = '5.0.1';

const NEEDED = ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'scrcpy-server', 'LICENSE.txt'];

/** Minimal zip reader (stored + deflate, no zip64): enough for the scrcpy release archive. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + compSize);
    files.set(name, () => (method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw)));
  }
  return files;
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const argv = process.argv.slice(2);
  const arch = argv.includes('--arch') ? argv[argv.indexOf('--arch') + 1] : 'x64';
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unknown --arch ${arch}`);
  const force = argv.includes('--force');

  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'bin');
  const stamp = `${SCRCPY_VERSION} ${arch}`;
  const stampFile = path.join(out, '.fetched');
  if (!force && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp && NEEDED.every((f) => fs.existsSync(path.join(out, f)))) {
    console.log(`scrcpy ${stamp} already in resources/bin`);
    return;
  }

  const asset = `scrcpy-${arch === 'arm64' ? 'winarm64' : 'win64'}-v${SCRCPY_VERSION}.zip`;
  const base = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/`;
  console.log(`Downloading ${asset} ...`);
  const [zip, sums] = await Promise.all([download(base + asset), download(base + 'SHA256SUMS.txt')]);

  const line = sums.toString('utf8').split(/\r?\n/).find((l) => l.trim().endsWith(asset));
  if (!line) throw new Error(`${asset} is not listed in SHA256SUMS.txt`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  console.log('Checksum OK');

  const files = readZip(zip);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const want of NEEDED) {
    const entry = [...files.keys()].find((k) => k.split('/').at(-1) === want);
    if (!entry) throw new Error(`${want} is missing from ${asset}`);
    fs.writeFileSync(path.join(out, want), files.get(entry)());
  }
  fs.writeFileSync(path.join(out, '.gitkeep'), '');  // keeps the folder in git while its contents stay ignored
  fs.writeFileSync(path.join(out, 'VERSION'), SCRCPY_VERSION + '\n');
  fs.writeFileSync(stampFile, stamp);
  console.log(`Unpacked ${NEEDED.join(', ')} into resources/bin`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
