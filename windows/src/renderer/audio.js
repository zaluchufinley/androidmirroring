// Audio playback (scrcpy "raw" codec: 48 kHz, stereo, signed 16-bit little-endian). Port of AudioPlayer in Core.swift.

const RATE = 48000;
const MAX_LEAD = 0.25;  // seconds of audio allowed to be queued ahead; beyond this, chunks are dropped so sound never lags the picture

export class PcmPlayer {
  #ctx = null;
  #next = 0;

  start() {
    this.#ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
    this.#next = 0;
    this.#ctx.resume().catch(() => {});
  }

  stop() {
    const ctx = this.#ctx;
    this.#ctx = null;
    ctx?.close().catch(() => {});
  }

  /** Plays one chunk of PCM (Uint8Array). */
  enqueue(pcm) {
    const ctx = this.#ctx;
    if (!ctx) return;
    const frames = pcm.byteLength >> 2;
    if (frames === 0) return;
    const now = ctx.currentTime;
    if (this.#next < now) this.#next = now + 0.04;  // underrun: restart with a small cushion
    if (this.#next - now > MAX_LEAD) return;        // fell behind: drop
    const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 4);
    const buf = ctx.createBuffer(2, frames, RATE);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = view.getInt16(i * 4, true) / 32768;
      right[i] = view.getInt16(i * 4 + 2, true) / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(this.#next);
    this.#next += frames / RATE;
  }
}
