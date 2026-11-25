// One mirroring session: starts scrcpy-server on the phone and talks to it over adb-forwarded sockets.
// Port of MirrorSession in Sources/Core.swift. Decoding happens in the renderer (WebCodecs); this side only moves bytes.

import net from 'node:net';
import crypto from 'node:crypto';
import { run, spawnLogged } from './exec.js';
import { Ctl, chunkText, parsePacketHeader, VIDEO_CODEC_H264, AUDIO_CODEC_RAW } from '../shared/protocol.js';
import { findAdb, findServerJar, scrcpyVersion, ADB_MISSING, SERVER_MISSING } from './tools.js';

export class SessionError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
const noop = () => {};

/** Reads exact byte counts from a socket; `read` resolves null once the socket is closed. */
export class Reader {
  #chunks = [];
  #length = 0;
  #closed = false;
  #waiter = null;

  constructor(socket) {
    socket.on('data', (d) => { this.#chunks.push(d); this.#length += d.length; this.#wake(); });
    const end = () => { this.#closed = true; this.#wake(); };
    socket.on('end', end);
    socket.on('close', end);
    socket.on('error', end);
  }

  #wake() {
    const w = this.#waiter;
    if (w) { this.#waiter = null; w(); }
  }

  async read(n) {
    if (n === 0) return Buffer.alloc(0);
    while (this.#length < n) {
      if (this.#closed) return null;
      await new Promise((resolve) => { this.#waiter = resolve; });
    }
    let out;
    const first = this.#chunks[0];
    if (first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) this.#chunks.shift(); else this.#chunks[0] = first.subarray(n);
    } else {
      const all = Buffer.concat(this.#chunks, this.#length);
      out = all.subarray(0, n);
      this.#chunks = all.length > n ? [all.subarray(n)] : [];
    }
    this.#length -= n;
    return out;
  }
}

/** Connects to 127.0.0.1:port, resolving null when nothing accepts. */
function tcpConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setNoDelay(true);
    s.on('error', noop);  // errors after connecting surface as a closed socket, never as an uncaught exception
    s.once('connect', () => resolve(s));
    s.once('close', () => resolve(null));
  });
}

export class MirrorSession {
  /**
   * @param {{serial: string, audio: boolean}} opts
   * @param {{onEvent: (e: object) => void, onVideo: (p: object) => void, onAudio: (pcm: Uint8Array) => void}} sinks
   *   events: {type:'meta', name} | {type:'size', width, height} | {type:'ended', reason: string|null}
   */
  constructor({ serial, audio }, sinks) {
    this.serial = serial;
    this.audio = audio;
    this.sinks = sinks;
    this.stopped = false;
    this.sawSessionPacket = false;
    this.displayOff = false;  // we turned the phone's screen off, so it must be turned on again when we leave
    this.serverLog = '';
    this.sockets = { video: null, audio: null, control: null };
    this.proc = null;
    this.procExited = false;
    this.fwdPort = null;
  }

  start() { this.#run(); }

  #emit(e) { try { this.sinks.onEvent(e); } catch (err) { console.error(err); } }

  #logTail() { return this.serverLog.split(/\r?\n/).filter(Boolean).slice(-4).join('\n'); }

  /**
   * Stops the session. If we turned the phone's screen off, it is switched back on first (the message is written before
   * the sockets are shut down). `waitMs` lets a quitting app give that message a moment to leave.
   */
  async stop(waitMs = 0) {
    const restore = this.displayOff && !this.stopped;
    this.stopped = true;
    this.displayOff = false;
    const control = this.sockets.control;
    if (!restore || !control || control.destroyed) { this.#shutdown(); return; }
    const flushed = new Promise((resolve) => {
      const done = () => { this.#shutdown(); resolve(); };
      control.write(Ctl.displayPower(true), done);
      setTimeout(done, 500);  // never leave the sockets open if the write stalls
    });
    if (waitMs > 0) await withTimeout(flushed, waitMs);
  }

  #shutdown() {
    for (const s of Object.values(this.sockets)) s?.destroy();
    if (this.proc && !this.procExited) this.proc.kill();
  }

  /** Turns the phone's own screen off (or back on) without interrupting the mirror or the controls. */
  setPhoneScreen(on) {
    this.displayOff = !on;
    this.send(Ctl.displayPower(on));
  }

  send(buf) {
    const c = this.sockets.control;
    if (c && c.writable && !c.destroyed) c.write(buf);
  }

  sendText(s) { for (const chunk of chunkText(s)) this.send(Ctl.text(chunk)); }

  tapKey(code) {
    this.send(Ctl.key(0, code));
    this.send(Ctl.key(1, code));
  }

  async #run() {
    let reason = null;
    try { await this.#connectAndStream(); } catch (e) { reason = e instanceof SessionError ? e.message : String(e?.message ?? e); }
    await this.#cleanup();
    if (!this.stopped) this.#emit({ type: 'ended', reason });
  }

  async #cleanup() {
    this.#shutdown();
    const adb = findAdb();
    if (this.fwdPort != null && adb) {
      const p = this.fwdPort;
      this.fwdPort = null;
      await run(adb, ['-s', this.serial, 'forward', '--remove', `tcp:${p}`], { timeout: 5000 });
    }
  }

  async #connectAndStream() {
    const adb = findAdb();
    if (!adb) throw new SessionError(ADB_MISSING);
    const jar = findServerJar();
    if (!jar) throw new SessionError(SERVER_MISSING);
    const serial = this.serial;
    const version = await scrcpyVersion();

    const push = await run(adb, ['-s', serial, 'push', jar, '/data/local/tmp/scrcpy-server.jar'], { timeout: 60_000 });
    if (push.status !== 0) throw new SessionError('Could not copy the server to the phone.\n' + push.out.slice(-200));
    if (this.stopped) return;

    const scid = crypto.randomInt(1, 0x7fff_ffff).toString(16).padStart(8, '0');
    const fwd = await run(adb, ['-s', serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scid}`], { timeout: 15_000 });
    const portText = fwd.out.trim();
    if (fwd.status !== 0 || !/^\d+$/.test(portText)) throw new SessionError('adb forward failed.\n' + fwd.out.slice(-200));
    const port = Number(portText);
    this.fwdPort = port;

    this.proc = spawnLogged(adb, [
      '-s', serial, 'shell', 'CLASSPATH=/data/local/tmp/scrcpy-server.jar', 'app_process', '/',
      'com.genymobile.scrcpy.Server', version,
      `scid=${scid}`, 'log_level=info', 'tunnel_forward=true',
      this.audio ? 'audio=true' : 'audio=false', 'audio_codec=raw',
      'control=true', 'max_size=1920', 'max_fps=60',
      'video_bit_rate=16000000', 'clipboard_autosync=false',
    ], (text) => { this.serverLog += text; });
    this.proc.on('exit', () => { this.procExited = true; });
    this.proc.on('error', (e) => { this.serverLog += String(e); this.procExited = true; });
    if (this.stopped) { this.proc.kill(); return; }

    // Video socket first; the server sends a dummy byte once it is really listening.
    let vreader = null;
    for (let tries = 0; ; tries++) {
      if (this.stopped) return;
      if (tries > 150) throw new SessionError(this.#logTail() || 'Could not reach the server on the phone.');
      if (this.procExited) throw new SessionError(this.#logTail() || 'The server on the phone stopped unexpectedly.');
      const s = await tcpConnect(port);
      if (s) {
        const r = new Reader(s);
        const b = await withTimeout(r.read(1), 5000);
        if (b) { this.sockets.video = s; vreader = r; break; }
        s.destroy();
      }
      await sleep(100);
    }

    // Then the audio socket (only when sound is routed to the PC), then control.
    let areader = null;
    if (this.audio) {
      for (let tries = 0; !areader; tries++) {
        if (this.stopped) return;
        if (tries > 40) throw new SessionError('Could not open the audio channel.');
        const s = await tcpConnect(port);
        if (s) { this.sockets.audio = s; areader = new Reader(s); } else await sleep(100);
      }
    }
    for (let tries = 0; !this.sockets.control; tries++) {
      if (this.stopped) return;
      if (tries > 40) throw new SessionError('Could not open the control channel.');
      const s = await tcpConnect(port);
      if (s) this.sockets.control = s; else await sleep(100);
    }
    this.sockets.control.on('data', noop);  // drain device->client messages (clipboard, acks)

    const closedMsg = () => new SessionError('The phone closed the connection.\n' + this.#logTail());
    const nameData = await vreader.read(64);
    if (!nameData) throw closedMsg();
    const codec = await vreader.read(4);
    if (!codec) throw closedMsg();
    if (!codec.equals(VIDEO_CODEC_H264)) throw new SessionError('Unsupported video codec.');
    const zero = nameData.indexOf(0);
    this.#emit({ type: 'meta', name: nameData.subarray(0, zero < 0 ? 64 : zero).toString('utf8') });

    if (areader) this.#audioLoop(areader);

    while (!this.stopped) {
      const hd = await vreader.read(12);
      if (!hd) break;
      const h = parsePacketHeader(hd);
      if (h.session) {  // session packet: the new frame size
        this.sawSessionPacket = true;
        this.#emit({ type: 'size', width: h.width, height: h.height });
        continue;
      }
      if (h.size > 32 << 20) break;  // a frame is never this big: bad stream
      const payload = await vreader.read(h.size);
      if (!payload) break;
      // Copy: a view into a big receive buffer would drag the whole buffer through IPC.
      this.sinks.onVideo({ data: new Uint8Array(payload), pts: h.pts, key: h.key });
    }
    if (!this.stopped) throw new SessionError('The phone stopped sending video.\n' + this.#logTail());
  }

  async #audioLoop(reader) {
    // First 4 bytes: codec id. 0 = disabled by the device, 1 = error (e.g. Android older than 11).
    const cid = await reader.read(4);
    if (!cid || cid.readUInt32BE(0) !== AUDIO_CODEC_RAW) return;
    while (!this.stopped) {
      const hd = await reader.read(12);
      if (!hd) break;
      const h = parsePacketHeader(hd);
      if (h.size > 1 << 20) break;
      const payload = await reader.read(h.size);
      if (!payload) break;
      if (h.config) continue;  // raw audio has no config packet
      this.sinks.onAudio(new Uint8Array(payload));
    }
  }
}

