// Integration test of MirrorSession against a fake adb and a fake scrcpy-server speaking the real socket protocol.
// Needs a POSIX shell for the fake adb, so it is skipped on Windows (CI there runs the unit tests only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ctl, Key } from '../src/shared/protocol.js';

const skip = process.platform === 'win32' ? 'needs a POSIX shell' : false;

/** A fake scrcpy-server: the first connection is video, then (optionally) audio, then control. */
function fakeServer({ audio }) {
  const got = { control: [], conns: 0 };
  const sockets = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    const idx = got.conns++;
    const role = idx === 0 ? 'video' : (audio && idx === 1 ? 'audio' : 'control');
    if (role === 'video') {
      s.write(Buffer.from([0]));  // dummy byte: "really listening"
      const name = Buffer.alloc(64); name.write('Fake Phone');
      s.write(name);
      s.write(Buffer.from('h264'));
      const session = Buffer.alloc(12); session[0] = 0x80; session.writeUInt32BE(1080, 4); session.writeUInt32BE(2400, 8);
      s.write(session);
      const nal = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x2a]), Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3])]);
      const hdr = Buffer.alloc(12); hdr.writeBigUInt64BE((1n << 61n) | 5000n); hdr.writeUInt32BE(nal.length, 8);
      // deliver the frame in two slices to prove reads cope with fragmentation
      const all = Buffer.concat([hdr, nal]);
      s.write(all.subarray(0, 7));
      setTimeout(() => s.write(all.subarray(7)), 20);
    } else if (role === 'audio') {
      const codec = Buffer.alloc(4); codec.writeUInt32BE(0x00726177);
      s.write(codec);
      const pcm = Buffer.alloc(16, 7);
      const hdr = Buffer.alloc(12); hdr.writeUInt32BE(pcm.length, 8);
      s.write(Buffer.concat([hdr, pcm]));
    } else {
      s.on('data', (d) => got.control.push(d));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, got,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  })));
}

async function setup({ audio }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-test-'));
  const server = await fakeServer({ audio });
  const log = path.join(dir, 'adb.log');
  const adb = path.join(dir, 'adb');
  fs.writeFileSync(adb, `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *" forward tcp:0 "*) echo ${server.port}; exit 0;;
  *" shell "*) exec sleep 30;;
  *) exit 0;;
esac
`, { mode: 0o755 });
  const jar = path.join(dir, 'scrcpy-server');
  fs.writeFileSync(jar, 'jar');
  process.env.AM_ADB = adb;
  process.env.AM_SCRCPY_SERVER = jar;
  process.env.AM_SCRCPY_VERSION = '5.0.1';
  const { MirrorSession } = await import('../src/main/session.js');
  return { dir, server, log, MirrorSession, cleanup: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const until = async (cond, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('a session streams video, reports size, relays control, and tidies up', { skip }, async () => {
  const t = await setup({ audio: false });
  const events = [], video = [];
  const s = new t.MirrorSession({ serial: 'FAKE1', audio: false }, {
    onEvent: (e) => events.push(e), onVideo: (p) => video.push(p), onAudio: () => assert.fail('audio was not requested'),
  });
  s.start();
  await until(() => video.length === 1);

  assert.deepEqual(events.filter((e) => e.type === 'meta'), [{ type: 'meta', name: 'Fake Phone' }]);
  assert.deepEqual(events.filter((e) => e.type === 'size'), [{ type: 'size', width: 1080, height: 2400 }]);
  assert.equal(s.sawSessionPacket, true);
  assert.equal(video[0].key, true);
  assert.equal(video[0].pts, 5000);
  assert.deepEqual([...video[0].data], [0, 0, 0, 1, 0x67, 0x64, 0, 0x2a, 0, 0, 0, 1, 0x65, 1, 2, 3]);
  assert.ok(video[0].data.buffer.byteLength === video[0].data.length, 'payload must be a compact copy');

  // control messages arrive in order and byte-exact
  s.tapKey(Key.home);
  s.send(Ctl.backOrScreenOn(0));
  s.sendText('héllo');
  await until(() => Buffer.concat(t.server.got.control).length >= 14 + 14 + 2 + 11);
  assert.equal(Buffer.concat(t.server.got.control).toString('hex'),
    Ctl.key(0, Key.home).toString('hex') + Ctl.key(1, Key.home).toString('hex') + '0400' + Ctl.text('héllo').toString('hex'));

  // what was run on the "phone"
  const log = fs.readFileSync(t.log, 'utf8');
  assert.match(log, /-s FAKE1 push .*scrcpy-server \/data\/local tmp\/scrcpy-server\.jar|-s FAKE1 push .*scrcpy-server \/data\/local\/tmp\/scrcpy-server\.jar/);
  assert.match(log, /-s FAKE1 forward tcp:0 localabstract:scrcpy_[0-9a-f]{8}/);
  assert.match(log, /app_process \/ com\.genymobile\.scrcpy\.Server 5\.0\.1 scid=[0-9a-f]{8} log_level=info tunnel_forward=true audio=false audio_codec=raw control=true max_size=1920 max_fps=60 video_bit_rate=16000000 clipboard_autosync=false/);

  await s.stop();
  await until(() => /forward --remove tcp:\d+/.test(fs.readFileSync(t.log, 'utf8')));
  assert.equal(events.some((e) => e.type === 'ended'), false, 'a stop we asked for is not an "ended" event');
  t.cleanup();
});

test('turning the phone screen off is undone when the session stops', { skip }, async () => {
  const t = await setup({ audio: false });
  const video = [];
  const s = new t.MirrorSession({ serial: 'FAKE2', audio: false }, { onEvent() {}, onVideo: (p) => video.push(p), onAudio() {} });
  s.start();
  await until(() => video.length === 1);
  s.setPhoneScreen(false);
  await until(() => Buffer.concat(t.server.got.control).length >= 2);
  await s.stop(1000);
  await until(() => Buffer.concat(t.server.got.control).length >= 4);
  assert.equal(Buffer.concat(t.server.got.control).toString('hex'), '0a00' + '0a01');
  t.cleanup();
});

test('audio is requested and delivered as raw PCM when sound is routed to the PC', { skip }, async () => {
  const t = await setup({ audio: true });
  const pcm = [], video = [];
  const s = new t.MirrorSession({ serial: 'FAKE3', audio: true }, { onEvent() {}, onVideo: (p) => video.push(p), onAudio: (p) => pcm.push(p) });
  s.start();
  await until(() => pcm.length === 1 && video.length === 1);
  assert.equal(pcm[0].length, 16);
  assert.ok(pcm[0].every((b) => b === 7));
  assert.match(fs.readFileSync(t.log, 'utf8'), / audio=true audio_codec=raw /);
  await s.stop();
  t.cleanup();
});

test('a server that goes away is reported as an ended session with the server log', { skip }, async () => {
  const t = await setup({ audio: false });
  const events = [];
  const s = new t.MirrorSession({ serial: 'FAKE4', audio: false }, { onEvent: (e) => events.push(e), onVideo() {}, onAudio() {} });
  s.start();
  await until(() => events.some((e) => e.type === 'meta'));
  t.server.close();  // the phone vanishes
  await until(() => events.some((e) => e.type === 'ended'));
  const ended = events.find((e) => e.type === 'ended');
  assert.match(ended.reason, /The phone stopped sending video/);
  t.cleanup();
});

test('a missing adb is reported plainly', { skip }, async (tc) => {
  const t = await setup({ audio: false });
  process.env.AM_ADB = path.join(t.dir, 'does-not-exist');
  const oldPath = process.env.PATH;
  process.env.PATH = '';  // and none on PATH either
  try {
    const { findAdb } = await import('../src/main/tools.js');
    if (findAdb()) { tc.skip('an adb exists in a well-known folder on this machine, so "missing" cannot be produced'); return; }
    const events = [];
    const s = new t.MirrorSession({ serial: 'X', audio: false }, { onEvent: (e) => events.push(e), onVideo() {}, onAudio() {} });
    s.start();
    await until(() => events.some((e) => e.type === 'ended'));
    assert.match(events.at(-1).reason, /adb was not found/);
  } finally {
    process.env.PATH = oldPath;
    t.cleanup();
  }
});
