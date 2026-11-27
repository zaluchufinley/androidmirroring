// Downloads the pinned scrcpy release for Windows (or Linux x64) and unpacks the few files the app needs (adb and the server jar)
// into resources/bin, which the installer ships. The download is checked against the SHA-256 pinned in this file.
//
//   node scripts/fetch-scrcpy.js [--os win|linux] [--arch x64|arm64] [--force]   (linux: x64 only, scrcpy ships no ARM build)
//
// The version must match the server jar it ships with, so it is written to resources/bin/VERSION.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SCRCPY_VERSION = '5.0.1';

// SHA-256 of each release archive, pinned here (not read from the release itself, which an attacker who replaces an
// archive could replace too). Update these together with SCRCPY_VERSION: `shasum -a 256 <downloaded archive>`.
const SHA256 = {
  'scrcpy-win64-v5.0.1.zip': 'b12a2c4ee8be317422451fc7dcf8ee20a71b5ea7ef9ad73ddd825a25316227a5',
  'scrcpy-winarm64-v5.0.1.zip': '16c3fc2068df64946f670e3504b4752073ebae47a416a45b46e79a5ab19c689b',
  'scrcpy-linux-x86_64-v5.0.1.tar.gz': '9f969d30cc574816077edecda65719c1c70b0aee1df1ba5fa00779ac07b8fd6e',
};

const NEEDED = {
  win: ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'scrcpy-server', 'LICENSE.txt'],
  linux: ['adb', 'scrcpy-server', 'LICENSE'],
};

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

/** Minimal tar reader (ustar, regular files): enough for the scrcpy Linux archive. Returns name -> content getter. */
export function readTar(buf) {
  const files = new Map();
  for (let p = 0; p + 512 <= buf.length && buf[p] !== 0; ) {
    const name = buf.toString('utf8', p, p + 100).replace(/\0.*$/s, '');
    const size = parseInt(buf.toString('ascii', p + 124, p + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(buf[p + 156]);
    const data = buf.subarray(p + 512, p + 512 + size);
    if (type === '0' || type === '\0') files.set(name, () => Buffer.from(data));
    p += 512 + Math.ceil(size / 512) * 512;
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
  const os = argv.includes('--os') ? argv[argv.indexOf('--os') + 1] : 'win';
  if (!NEEDED[os]) throw new Error(`Unknown --os ${os}`);
  const arch = argv.includes('--arch') ? argv[argv.indexOf('--arch') + 1] : 'x64';
  if (!['x64', 'arm64'].includes(arch) || (os === 'linux' && arch !== 'x64')) throw new Error(`Unsupported --arch ${arch} for ${os}`);
  const force = argv.includes('--force');

  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'bin');
  const needed = NEEDED[os];
  const stamp = `${SCRCPY_VERSION} ${os} ${arch}`;
  const stampFile = path.join(out, '.fetched');
  if (!force && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp && needed.every((f) => fs.existsSync(path.join(out, f)))) {
    console.log(`scrcpy ${stamp} already in resources/bin`);
    return;
  }

  const asset = os === 'linux'
    ? `scrcpy-linux-x86_64-v${SCRCPY_VERSION}.tar.gz`
    : `scrcpy-${arch === 'arm64' ? 'winarm64' : 'win64'}-v${SCRCPY_VERSION}.zip`;
  const base = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/`;
  console.log(`Downloading ${asset} ...`);
  const zip = await download(base + asset);

  const expected = SHA256[asset];
  if (!expected) throw new Error(`No pinned SHA-256 for ${asset}`);
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  console.log('Checksum OK');

  const files = os === 'linux' ? readTar(zlib.gunzipSync(zip)) : readZip(zip);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const want of needed) {
    const entry = [...files.keys()].find((k) => k.split('/').at(-1) === want);
    if (!entry) throw new Error(`${want} is missing from ${asset}`);
    fs.writeFileSync(path.join(out, want), files.get(entry)(), { mode: 0o755 });  // adb must be executable on Linux
  }
  fs.writeFileSync(path.join(out, '.gitkeep'), '');  // keeps the folder in git while its contents stay ignored
  fs.writeFileSync(path.join(out, 'VERSION'), SCRCPY_VERSION + '\n');
  fs.writeFileSync(stampFile, stamp);
  console.log(`Unpacked ${needed.join(', ')} into resources/bin`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
