// H.264 (Annex B, as scrcpy sends it) -> VideoDecoder (WebCodecs). Port of H264Feeder in Sources/Core.swift.

/** Splits an Annex B buffer into NAL units (start codes removed). */
export function splitNALs(b) {
  const starts = [];
  let i = 0;
  while (i + 3 <= b.length) {
    if (b[i] === 0 && b[i + 1] === 0) {
      if (b[i + 2] === 1) { starts.push([i, 3]); i += 3; continue; }
      if (i + 4 <= b.length && b[i + 2] === 0 && b[i + 3] === 1) { starts.push([i, 4]); i += 4; continue; }
    }
    i += 1;
  }
  const out = [];
  starts.forEach(([pos, len], k) => {
    const begin = pos + len;
    const end = k + 1 < starts.length ? starts[k + 1][0] : b.length;
    if (end > begin) out.push(b.subarray(begin, end));
  });
  return out;
}

export const nalType = (nal) => nal[0] & 0x1f;

/** WebCodecs codec string from an SPS NAL: avc1.<profile><constraints><level>. */
export function codecString(sps) {
  return 'avc1.' + [sps[1], sps[2], sps[3]].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Joins NAL units with 4-byte start codes. */
export function toAnnexB(nals) {
  let total = 0;
  for (const n of nals) total += 4 + n.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const n of nals) {
    out[o + 3] = 1;
    out.set(n, o + 4);
    o += 4 + n.length;
  }
  return out;
}

const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

export class H264Decoder {
  #decoder = null;
  #sps = null;
  #pps = null;
  #cfgSps = null;
  #cfgPps = null;
  #needKey = true;
  #failures = 0;
  #closed = false;
  #framesOut = 0;       // pictures this decoder has ever produced
  #software = false;    // fall back to the software decoder if the hardware one fails before its first picture

  /**
   * @param {{onFrame: (f: VideoFrame) => void, onNeedKeyframe: () => void, onFatal: (msg: string) => void}} cb
   */
  constructor({ onFrame, onNeedKeyframe, onFatal }) {
    this.onFrame = onFrame;
    this.onNeedKeyframe = onNeedKeyframe;
    this.onFatal = onFatal;
  }

  #configure() {
    if (this.#closed) return;
    try { if (this.#decoder && this.#decoder.state !== 'closed') this.#decoder.close(); } catch { /* already closed */ }
    this.#decoder = new VideoDecoder({
      output: (frame) => { this.#failures = 0; this.#framesOut++; this.onFrame(frame); },
      error: (e) => this.#onError(e),
    });
    this.#decoder.configure({
      codec: codecString(this.#sps),
      optimizeForLatency: true,
      avc: { format: 'annexb' },
      hardwareAcceleration: this.#software ? 'prefer-software' : 'no-preference',
    });
    this.#cfgSps = this.#sps;
    this.#cfgPps = this.#pps;
    this.#needKey = true;
  }

  #onError(e) {
    if (this.#closed) return;
    this.#decoder = null;  // an errored decoder is closed for good; a new one is made on the next key frame
    this.#needKey = true;
    if (!this.#software && this.#framesOut === 0) {
      // Never produced a picture: typically a GPU decoder that is missing or broken (a virtual machine, an old driver).
      this.#software = true;
      this.onNeedKeyframe();
      return;
    }
    this.#failures += 1;
    if (this.#failures > 3) { this.onFatal(e?.message ?? String(e)); return; }
    this.onNeedKeyframe();
  }

  /** Feeds one packet from the phone. Returns true if it was handed to the decoder. */
  push({ data, pts, key }) {
    if (this.#closed) return false;
    const rest = [];
    let sawParams = false;
    for (const nal of splitNALs(data)) {
      const t = nalType(nal);
      if (t === 7) { this.#sps = nal; sawParams = true; }
      else if (t === 8) { this.#pps = nal; sawParams = true; }
      else if (t !== 9) rest.push(nal);  // 9 = access unit delimiter
    }
    if (this.#sps && this.#pps && (!this.#decoder || (sawParams && !(same(this.#sps, this.#cfgSps) && same(this.#pps, this.#cfgPps))))) {
      this.#configure();
    }
    if (!this.#decoder || rest.length === 0) return false;  // config-only packet, or nothing to decode with yet

    const isKey = key || rest.some((n) => nalType(n) === 5);
    if (this.#needKey && !isKey) return false;
    // Falling behind: drop to the next key frame rather than show old pictures ever later.
    if (!isKey && this.#decoder.decodeQueueSize > 6) { this.#needKey = true; this.onNeedKeyframe(); return false; }
    if (isKey) this.#needKey = false;

    try {
      this.#decoder.decode(new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: pts,
        data: toAnnexB(isKey ? [this.#sps, this.#pps, ...rest] : rest),
      }));
    } catch (e) {
      this.#onError(e);
      return false;
    }
    return true;
  }

  close() {
    this.#closed = true;
    try { if (this.#decoder && this.#decoder.state !== 'closed') this.#decoder.close(); } catch { /* already closed */ }
    this.#decoder = null;
  }
}
