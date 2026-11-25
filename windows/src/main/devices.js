// Device discovery, wireless connect and pairing through adb. Port of tick/normalize/connect/pair in Sources/main.swift.

import { run } from './exec.js';

const STATES = new Set(['device', 'offline', 'unauthorized', 'authorizing', 'connecting', 'recovery', 'sideload', 'bootloader', 'no', 'host', 'rescue']);

/** Parses `adb devices -l`. adb also prints "* daemon ..." lines (stderr is merged) and a header; Windows adds \r. */
export function parseDevices(out) {
  const list = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('*') || line.startsWith('List of devices')) continue;
    const p = line.split(/[\t ]+/);
    if (p.length < 2 || !STATES.has(p[1])) continue;
    const modelPart = p.find((x) => x.startsWith('model:'));
    list.push({ serial: p[0], state: p[1], model: modelPart ? modelPart.slice(6).replaceAll('_', ' ') : '' });
  }
  return list;
}

/** Null when adb itself failed or hung: that is "unknown", not "no phones", so a live session must not be judged by it. */
export async function listDevices(adb) {
  const r = await run(adb, ['devices', '-l'], { timeout: 15_000 });
  return r.status < 0 ? null : parseDevices(r.out);
}

/** "192.168.0.101" -> "192.168.0.101:5555". Null when it cannot be an address. */
export function normalize(raw) {
  let a = raw.trim();
  if (!a || a.includes(' ') || a.startsWith('-')) return null;  // a leading "-" would be read by adb as an option
  if (!a.includes(':')) a += ':5555';
  const parts = a.split(':');
  if (parts.length !== 2 || !parts[0] || !/^\d+$/.test(parts[1])) return null;
  const port = Number(parts[1]);
  return port >= 1 && port <= 65535 ? a : null;
}

/** Returns { ok, out }. */
export async function adbConnect(adb, addr) {
  const out = (await run(adb, ['connect', addr], { timeout: 20_000 })).out.trim();
  const low = out.toLowerCase();
  return { ok: low.includes('connected to') && !low.includes('failed') && !low.includes('cannot'), out };
}

/** Returns { ok, address }: after pairing, the phone announces its connect address on the network; use it if we can see it. */
export async function adbPair(adb, addr, pin) {
  const out = (await run(adb, ['pair', addr, pin], { timeout: 30_000 })).out.trim();
  const ok = out.toLowerCase().includes('successfully paired');
  let address = null;
  if (ok) {
    const host = addr.split(':')[0];
    const mdns = (await run(adb, ['mdns', 'services'], { timeout: 10_000 })).out;
    for (const line of mdns.split(/\r?\n/)) {
      if (!line.includes('_adb-tls-connect')) continue;
      const last = line.trim().split(/[\t ]+/).at(-1);
      if (last?.startsWith(host + ':')) { address = last; break; }
    }
  }
  return { ok, address };
}
