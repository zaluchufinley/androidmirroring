// H264Decoder against a mock VideoDecoder: configuration, key-frame handling, backlog dropping and the software fallback.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { H264Decoder } from '../src/renderer/h264.js';

let decoders;
let failHardware;

class MockEncodedVideoChunk { constructor(init) { Object.assign(this, init); } }

class MockVideoDecoder {
  constructor({ output, error }) {
    this.output = output; this.error = error;
    this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = [];
    decoders.push(this);
  }
  configure(cfg) { this.cfg = cfg; this.state = 'configured'; }
  decode(chunk) {
    if (this.state === 'closed') throw new Error('closed');
    this.chunks.push(chunk);
    if (failHardware && this.cfg.hardwareAcceleration !== 'prefer-software') {
      this.state = 'closed';
      queueMicrotask(() => this.error(new Error('Decoding error.')));
      return;
    }
    queueMicrotask(() => this.output({ close() {}, displayWidth: 600, displayHeight: 1000 }));
  }
  close() { this.state = 'closed'; }
}

beforeEach(() => {
  decoders = [];
  failHardware = false;
  globalThis.VideoDecoder = MockVideoDecoder;
  globalThis.EncodedVideoChunk = MockEncodedVideoChunk;
});

const SPS = [0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda];
const PPS = [0, 0, 0, 1, 0x68, 0xce, 0x0f, 0xc8];
const IDR = [0, 0, 0, 1, 0x65, 0x88, 1, 2];
const P = [0, 0, 0, 1, 0x41, 0x9a, 3];
const pkt = (...parts) => ({ data: Uint8Array.from(parts.flat()), pts: 1000, key: false });
const flush = () => new Promise((r) => setTimeout(r, 0));

function make() {
  const log = { frames: 0, keyRequests: 0, fatal: null };
  const d = new H264Decoder({ onFrame: () => { log.frames++; }, onNeedKeyframe: () => { log.keyRequests++; }, onFatal: (m) => { log.fatal = m; } });
  return { d, log };
}

test('the decoder is configured from the SPS, in Annex B, and waits for a key frame', async () => {
  const { d } = make();
  assert.equal(d.push(pkt(SPS, PPS)), false, 'a config-only packet decodes nothing');
  assert.equal(decoders.length, 1);
  assert.equal(decoders[0].cfg.codec, 'avc1.42c01f');
  assert.deepEqual(decoders[0].cfg.avc, { format: 'annexb' });
  assert.equal(decoders[0].cfg.optimizeForLatency, true);
  assert.equal(d.push(pkt(P)), false, 'a delta frame before any key frame is dropped');
  assert.equal(d.push(pkt(IDR)), true);
  assert.equal(decoders[0].chunks[0].type, 'key');
});

test('a key frame is sent with the stored SPS and PPS in front, even if the packet carried none', () => {
  const { d } = make();
  d.push(pkt(SPS, PPS));
  d.push(pkt(IDR));
  assert.deepEqual([...decoders[0].chunks[0].data], [...SPS, ...PPS, ...IDR]);
  d.push(pkt(P));
  assert.deepEqual([...decoders[0].chunks[1].data], [...P]);
  assert.equal(decoders[0].chunks[1].type, 'delta');
});

test('a changed SPS (rotation, new resolution) reconfigures and waits for the next key frame', () => {
  const { d } = make();
  d.push(pkt(SPS, PPS));
  d.push(pkt(IDR));
  const SPS2 = [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xac];
  d.push(pkt(SPS2, PPS));
  assert.equal(decoders.length, 2);
  assert.equal(decoders[1].cfg.codec, 'avc1.64002a');
  assert.equal(d.push(pkt(P)), false);
  assert.equal(d.push(pkt(IDR)), true);
});

test('an identical SPS/PPS repeated before every key frame does not reconfigure', () => {
  const { d } = make();
  d.push(pkt(SPS, PPS, IDR));
  d.push(pkt(P));
  d.push(pkt(SPS, PPS, IDR));
  assert.equal(decoders.length, 1);
  assert.equal(decoders[0].chunks.length, 3);
});

test('falling behind drops delta frames and asks for a key frame', () => {
  const { d, log } = make();
  d.push(pkt(SPS, PPS, IDR));
  decoders[0].decodeQueueSize = 20;
  assert.equal(d.push(pkt(P)), false);
  assert.equal(log.keyRequests, 1);
  decoders[0].decodeQueueSize = 0;
  assert.equal(d.push(pkt(P)), false, 'still waiting for the key frame');
  assert.equal(d.push(pkt(IDR)), true);
});

test('a decoder that fails before its first picture is retried in software', async () => {
  failHardware = true;
  const { d, log } = make();
  d.push(pkt(SPS, PPS, IDR));
  await flush();
  assert.equal(log.keyRequests, 1, 'a new key frame is requested');
  assert.equal(log.fatal, null, 'not fatal yet');
  d.push(pkt(P));                    // no decoder yet / waiting for a key frame
  d.push(pkt(IDR));                  // the key frame arrives: a software decoder is made
  await flush();
  assert.equal(decoders.length, 2);
  assert.equal(decoders[1].cfg.hardwareAcceleration, 'prefer-software');
  assert.equal(log.frames, 1);
  assert.equal(log.fatal, null);
});

test('a decoder that keeps failing in software is reported as fatal', async () => {
  class AlwaysFails extends MockVideoDecoder {
    decode() { this.state = 'closed'; queueMicrotask(() => this.error(new Error('Decoding error.'))); }
  }
  globalThis.VideoDecoder = AlwaysFails;
  const { d, log } = make();
  for (let i = 0; i < 8; i++) { d.push(pkt(SPS, PPS, IDR)); await flush(); }
  assert.match(log.fatal ?? '', /Decoding error/);
});

test('a hardware decoder that worked and then fails recovers without going to software', async () => {
  const { d, log } = make();
  d.push(pkt(SPS, PPS, IDR));
  await flush();
  assert.equal(log.frames, 1);
  decoders[0].state = 'closed';
  decoders[0].error(new Error('device lost'));
  assert.equal(log.keyRequests, 1);
  d.push(pkt(SPS, PPS, IDR));
  await flush();
  assert.equal(decoders.length, 2);
  assert.notEqual(decoders[1].cfg.hardwareAcceleration, 'prefer-software');
  assert.equal(log.frames, 2);
});

test('close() stops everything', () => {
  const { d } = make();
  d.push(pkt(SPS, PPS, IDR));
  d.close();
  assert.equal(d.push(pkt(P)), false);
  assert.equal(decoders[0].state, 'closed');
});
