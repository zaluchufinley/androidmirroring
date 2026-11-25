// scrcpy control protocol (client -> server messages) and stream-header helpers.
// A direct port of `Ctl` / `Key` in Sources/Core.swift: the bytes must stay identical.

export const Key = {
  home: 3, back: 4, up: 19, down: 20, left: 21, right: 22,
  tab: 61, enter: 66, del: 67, fwdDel: 112, appSwitch: 187,
};

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const Ctl = {
  expandNotifications: 5,
  collapsePanels: 7,
  resetVideo: 17,

  position(x, y, w, h) {
    return Buffer.concat([i32(x), i32(y), u16(clamp(w, 0, 65535)), u16(clamp(h, 0, 65535))]);
  },

  /** action: 0 down, 1 up, 2 move */
  touch({ action, x, y, w, h, pressure, buttons }) {
    return Buffer.concat([
      Buffer.from([2, action]),
      u64(0xffff_ffff_ffff_fffen),  // generic finger
      Ctl.position(x, y, w, h),
      u16(Math.trunc(clamp(pressure, 0, 1) * 65535)),
      u32(0),
      u32(buttons),
    ]);
  },

  scroll({ x, y, w, h, hscroll, vscroll }) {
    const fp = (v) => {
      const n = clamp(v / 16, -1, 1);
      const i = clamp(Math.trunc(n * 32768), -32768, 32767);
      const b = Buffer.alloc(2); b.writeInt16BE(i);
      return b;
    };
    return Buffer.concat([Buffer.from([3]), Ctl.position(x, y, w, h), fp(hscroll), fp(vscroll), u32(0)]);
  },

  key(action, code) {
    return Buffer.concat([Buffer.from([0, action]), u32(code), u32(0), u32(0)]);
  },

  text(s) {
    const bytes = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from([1]), u32(bytes.length), bytes]);
  },

  backOrScreenOn(action) { return Buffer.from([4, action]); },
  simple(type) { return Buffer.from([type]); },

  /** SET_DISPLAY_POWER: turns the phone's physical screen off/on while mirroring and control carry on. */
  displayPower(on) { return Buffer.from([10, on ? 1 : 0]); },

  clipboard(s, paste) {
    // A cut character becomes U+FFFD, never invalid UTF-8.
    const bytes = Buffer.from(Buffer.from(s, 'utf8').subarray(0, 262_000).toString('utf8'), 'utf8');
    return Buffer.concat([Buffer.from([9]), u64(0), Buffer.from([paste ? 1 : 0]), u32(bytes.length), bytes]);
  },
};

/** Splits text into chunks of at most `limit` UTF-8 bytes without ever cutting a character. */
export function chunkText(s, limit = 300) {
  const out = [];
  let chunk = '';
  let size = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (size + n > limit) { out.push(chunk); chunk = ''; size = 0; }
    chunk += ch;
    size += n;
  }
  if (chunk) out.push(chunk);
  return out;
}

// MARK: stream headers

/** The 12-byte header in front of every video/audio packet. */
export function parsePacketHeader(h) {
  const flags = h[0];
  return {
    session: (flags & 0x80) !== 0,   // video only: a "session" packet carrying the new frame size
    config: (flags & 0x40) !== 0,    // audio only here; video config packets carry SPS/PPS and are fed like any other
    key: (flags & 0x20) !== 0,
    pts: Number(h.readBigUInt64BE(0) & 0x1fff_ffff_ffff_ffffn),
    size: h.readUInt32BE(8),
    width: h.readUInt32BE(4),
    height: h.readUInt32BE(8),
  };
}

export const VIDEO_CODEC_H264 = Buffer.from([0x68, 0x32, 0x36, 0x34]);  // "h264"
export const AUDIO_CODEC_RAW = 0x0072_6177;                              // "raw"
