// Golden vectors: the hex below was produced by the real Swift `Ctl` (Sources/Core.swift) compiled on macOS, so these
// tests prove the Windows port writes exactly the same bytes to the phone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ctl, Key, chunkText, parsePacketHeader } from '../src/shared/protocol.js';

const hex = (b) => b.toString('hex');

test('touch messages match the Swift encoder', () => {
  assert.equal(hex(Ctl.touch({ action: 0, x: 540, y: 1200, w: 1080, h: 2400, pressure: 1, buttons: 1 })),
    '0200fffffffffffffffe0000021c000004b004380960ffff0000000000000001');
  assert.equal(hex(Ctl.touch({ action: 1, x: 1079, y: 2399, w: 1080, h: 2400, pressure: 0, buttons: 0 })),
    '0201fffffffffffffffe000004370000095f0438096000000000000000000000');
  assert.equal(hex(Ctl.touch({ action: 2, x: 12, y: 34, w: 1080, h: 2400, pressure: 0.5, buttons: 1 })),
    '0202fffffffffffffffe0000000c00000022043809607fff0000000000000001');
});

test('touch clamps the screen size to 16 bits and keeps negative coordinates signed', () => {
  assert.equal(hex(Ctl.touch({ action: 2, x: -5, y: -7, w: 70000, h: 2400, pressure: 1, buttons: 1 })),
    '0202fffffffffffffffefffffffbfffffff9ffff0960ffff0000000000000001');
});

test('scroll messages match the Swift encoder', () => {
  assert.equal(hex(Ctl.scroll({ x: 100, y: 200, w: 1080, h: 2400, hscroll: 0, vscroll: -1 })), '0300000064000000c8043809600000f80000000000');
  assert.equal(hex(Ctl.scroll({ x: 100, y: 200, w: 1080, h: 2400, hscroll: 99, vscroll: 5.5 })), '0300000064000000c8043809607fff2c0000000000');
  assert.equal(hex(Ctl.scroll({ x: 1, y: 2, w: 1080, h: 2400, hscroll: -0.3, vscroll: 0.31 })), '03000000010000000204380960fd9a027a00000000');
});

test('key and text messages match the Swift encoder', () => {
  assert.equal(hex(Ctl.key(0, Key.home)), '0000000000030000000000000000');
  assert.equal(hex(Ctl.key(1, Key.appSwitch)), '0001000000bb0000000000000000');
  assert.equal(hex(Ctl.text('hello')), '010000000568656c6c6f');
  assert.equal(hex(Ctl.text('héllo 世界 🙂')), '010000001268c3a96c6c6f20e4b896e7958c20f09f9982');
});

test('simple messages match the Swift encoder', () => {
  assert.equal(hex(Ctl.backOrScreenOn(0)), '0400');
  assert.equal(hex(Ctl.backOrScreenOn(1)), '0401');
  assert.equal(hex(Ctl.simple(Ctl.expandNotifications)), '05');
  assert.equal(hex(Ctl.simple(Ctl.collapsePanels)), '07');
  assert.equal(hex(Ctl.simple(Ctl.resetVideo)), '11');
  assert.equal(hex(Ctl.displayPower(false)), '0a00');
  assert.equal(hex(Ctl.displayPower(true)), '0a01');
});

test('clipboard messages match the Swift encoder', () => {
  assert.equal(hex(Ctl.clipboard('copy me ✓', true)), '090000000000000000010000000b636f7079206d6520e29c93');
  assert.equal(hex(Ctl.clipboard('x', false)), '090000000000000000000000000178');
});

test('a clipboard cut in the middle of a character never produces invalid UTF-8', () => {
  const m = Ctl.clipboard('é'.repeat(200_000), true);  // 400 000 bytes, cut at 262 000 (even: on a boundary)
  const body = m.subarray(14);
  assert.equal(m.readUInt32BE(10), body.length);
  assert.ok(body.length <= 262_000 + 2);
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(body));
  const odd = Ctl.clipboard('a' + 'é'.repeat(200_000), true);  // now the cut lands inside a character
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(odd.subarray(14)));
});

test('chunkText never splits a character and respects the byte limit', () => {
  const s = '你好世界🙂'.repeat(60);
  const chunks = chunkText(s, 300);
  assert.equal(chunks.join(''), s);
  for (const c of chunks) assert.ok(Buffer.byteLength(c) <= 300);
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('hi'), ['hi']);
});

test('packet headers: flags and pts are split like the Swift reader', () => {
  const h = Buffer.alloc(12);
  h.writeBigUInt64BE((1n << 61n) | 123456n);  // key frame flag (0x20 in byte 0) + pts
  h.writeUInt32BE(4096, 8);
  const p = parsePacketHeader(h);
  assert.equal(p.key, true);
  assert.equal(p.session, false);
  assert.equal(p.config, false);
  assert.equal(p.pts, 123456);
  assert.equal(p.size, 4096);

  const s = Buffer.alloc(12);
  s[0] = 0x80;
  s.writeUInt32BE(1080, 4);
  s.writeUInt32BE(2400, 8);
  const sp = parsePacketHeader(s);
  assert.equal(sp.session, true);
  assert.equal(sp.width, 1080);
  assert.equal(sp.height, 2400);

  const c = Buffer.alloc(12);
  c[0] = 0x40;
  assert.equal(parsePacketHeader(c).config, true);
});
