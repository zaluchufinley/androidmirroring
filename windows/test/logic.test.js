import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitNALs, nalType, codecString, toAnnexB } from '../src/renderer/h264.js';
import { parseDevices, normalize } from '../src/main/devices.js';
import { summary } from '../src/main/transfer.js';
import {
  aspectOf, minWidthFor, maxWidthFor, baseWidthFor, frameForWidth, interpolateFrame, panelAfterSwipe, easeOutQuart,
} from '../src/main/windowing.js';

// ---- H.264

test('splitNALs handles 3- and 4-byte start codes', () => {
  const data = Uint8Array.from([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 9, 9, 9]);
  const nals = splitNALs(data);
  assert.deepEqual(nals.map((n) => [...n]), [[0x67, 1, 2], [0x68, 3], [0x65, 9, 9, 9]]);
  assert.deepEqual(nals.map(nalType), [7, 8, 5]);
});

test('splitNALs on data without a start code gives nothing', () => {
  assert.deepEqual(splitNALs(Uint8Array.from([1, 2, 3, 4, 5])), []);
  assert.deepEqual(splitNALs(new Uint8Array()), []);
});

test('codecString is avc1 + profile, constraints and level of the SPS', () => {
  assert.equal(codecString(Uint8Array.from([0x67, 0x64, 0x00, 0x2a, 0xff])), 'avc1.64002a');
  assert.equal(codecString(Uint8Array.from([0x67, 0x42, 0xc0, 0x1f])), 'avc1.42c01f');
});

test('toAnnexB joins NALs with 4-byte start codes', () => {
  const out = toAnnexB([Uint8Array.from([0x67, 1]), Uint8Array.from([0x65, 2, 3])]);
  assert.deepEqual([...out], [0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x65, 2, 3]);
  assert.deepEqual(splitNALs(out).map((n) => [...n]), [[0x67, 1], [0x65, 2, 3]]);
});

// ---- adb output

test('parseDevices copes with Windows line endings, daemon noise and wireless serials', () => {
  const out = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    'R5CT1234ABC            device usb:1-1 product:o1sxxx model:SM_G991B device:o1s transport_id:1',
    '192.168.0.101:42799    device product:x model:Pixel_8 device:y transport_id:2',
    'adb-ABC123-xYz._adb-tls-connect._tcp unauthorized transport_id:3',
    'emulator-5554          offline',
    '',
  ].join('\r\n');
  assert.deepEqual(parseDevices(out), [
    { serial: 'R5CT1234ABC', state: 'device', model: 'SM G991B' },
    { serial: '192.168.0.101:42799', state: 'device', model: 'Pixel 8' },
    { serial: 'adb-ABC123-xYz._adb-tls-connect._tcp', state: 'unauthorized', model: '' },
    { serial: 'emulator-5554', state: 'offline', model: '' },
  ]);
});

test('parseDevices ignores lines that are not devices', () => {
  assert.deepEqual(parseDevices('adb server is out of date.  killing...\nList of devices attached\n'), []);
});

test('normalize accepts host or host:port and rejects the rest', () => {
  assert.equal(normalize('192.168.0.101'), '192.168.0.101:5555');
  assert.equal(normalize('  192.168.0.101:42799 '), '192.168.0.101:42799');
  assert.equal(normalize('phone.local:5555'), 'phone.local:5555');
  for (const bad of ['', '   ', 'a b', '-s', '--help:1', '1.2.3.4:', ':5555', '1.2.3.4:0', '1.2.3.4:65536', '1.2.3.4:abc', 'a:1:2']) {
    assert.equal(normalize(bad), null, JSON.stringify(bad));
  }
});

test('transfer summary wording', () => {
  assert.equal(summary({ sentFiles: 1, installedApps: 0 }), 'Sent 1 file to Downloads');
  assert.equal(summary({ sentFiles: 2, installedApps: 1 }), 'Sent 2 files to Downloads · Installed 1 app');
  assert.equal(summary({ sentFiles: 0, installedApps: 3 }), 'Installed 3 apps');
});

// ---- window geometry

const wa = { x: 0, y: 0, width: 1920, height: 1040 };

test('aspect, min and max widths', () => {
  const a = aspectOf({ width: 1080, height: 2400 });
  assert.ok(Math.abs(a - 2.2222) < 1e-3);
  assert.equal(minWidthFor(a), 300);
  assert.equal(minWidthFor(0.5), 600);  // landscape: 300 px on the short side
  assert.equal(maxWidthFor(a, wa), Math.floor((1040 - 16) / a));
  assert.equal(maxWidthFor(0.5, wa), 1904);  // landscape is limited by the width of the screen
  assert.equal(baseWidthFor(a), 340);
  assert.equal(baseWidthFor(0.5), 680);
});

test('frameForWidth clamps the width and keeps the window on screen', () => {
  const a = 2400 / 1080;
  assert.deepEqual(frameForWidth({ x: 100, y: 100, width: 340, height: 756 }, 400, a, wa), { x: 100, y: 100, width: 400, height: Math.round(400 * a) });
  assert.equal(frameForWidth({ x: 0, y: 0, width: 340, height: 756 }, 10, a, wa).width, 300);
  const big = frameForWidth({ x: 0, y: 0, width: 340, height: 756 }, 5000, a, wa);
  assert.equal(big.width, Math.floor((1040 - 16) / a));
  // a window that would hang off the bottom/right is pulled back
  const f = frameForWidth({ x: 1800, y: 900, width: 340, height: 756 }, 400, a, wa);
  assert.equal(f.x + f.width, 1920);
  assert.equal(f.y + f.height, 1040);
  // and the top-left of the work area wins when nothing fits
  assert.deepEqual(frameForWidth({ x: -50, y: -50, width: 340, height: 756 }, 340, a, wa).x, 0);
});

test('frameForWidth respects a work area that does not start at the origin (second monitor, taskbar on top)', () => {
  const second = { x: 1920, y: 40, width: 1920, height: 1040 };
  const f = frameForWidth({ x: 1000, y: 0, width: 340, height: 756 }, 340, 2400 / 1080, second);
  assert.equal(f.x, 1920);
  assert.equal(f.y, 40);
});

test('interpolateFrame ends exactly on the target and keeps the ratio on the way', () => {
  const a = 2400 / 1080;
  const from = { x: 100, y: 100, width: 340, height: 756 };
  const to = { x: 100, y: 60, width: 700, height: Math.round(700 * a) };
  assert.deepEqual(interpolateFrame(from, to, 1, a), to);
  assert.deepEqual(interpolateFrame(from, to, 0, a), from);
  for (const p of [0.1, 0.4, 0.8]) {
    const f = interpolateFrame(from, to, p, a);
    assert.equal(f.height, Math.round(f.width * a));
    assert.ok(f.width >= 340 && f.width <= 700);
  }
  assert.equal(easeOutQuart(0), 0);
  assert.equal(easeOutQuart(1), 1);
  assert.ok(easeOutQuart(0.5) > 0.9);
});

test('swipes open and close the notification panel', () => {
  assert.equal(panelAfterSwipe(0.02, 0.4), true);   // pulled down from the top edge
  assert.equal(panelAfterSwipe(0.5, 0.2), false);   // pushed up
  assert.equal(panelAfterSwipe(0.3, 0.35), null);   // too short
  assert.equal(panelAfterSwipe(0.3, 0.6), null);    // down, but not from the top edge
});
