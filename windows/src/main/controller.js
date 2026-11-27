// Application logic: devices, connecting, pairing, the session, window sizing, actions.
// Port of AppController in Sources/main.swift; the renderer only draws and reports input.

import { screen, clipboard, systemPreferences } from 'electron';
import { Ctl, Key } from '../shared/protocol.js';
import { MirrorSession } from './session.js';
import { findAdb, ADB_MISSING } from './tools.js';
import { listDevices, normalize, adbConnect, adbPair } from './devices.js';
import { sendFiles, summary } from './transfer.js';
import {
  DEFAULT_VIDEO, aspectOf, minWidthFor, maxWidthFor, baseWidthFor, frameForWidth, interpolateFrame, panelAfterSwipe,
  BASE_SHORT_SIDE,
} from './windowing.js';

const KEYS = {
  home: Key.home, back: Key.back, up: Key.up, down: Key.down, left: Key.left, right: Key.right,
  tab: Key.tab, enter: Key.enter, del: Key.del, fwdDel: Key.fwdDel, appSwitch: Key.appSwitch,
};

export class AppController {
  constructor(win, prefs) {
    this.win = win;
    this.prefs = prefs;
    this.session = null;
    this.sid = 0;                       // identifies a session, so late frames from a finished one are ignored
    this.shownSid = 0;                  // the session whose first picture has been shown
    this.mode = 'connect';              // 'connect' | 'streaming'
    this.videoSize = { ...DEFAULT_VIDEO };
    this.devices = [];
    this.polling = false;
    this.panelOpen = false;             // our best guess whether the phone's notification panel is open
    this.generation = 0;                // bumps whenever a connect attempt is cancelled or replaced
    this.restoreWidth = null;
    this.targetWidth = BASE_SHORT_SIDE;
    this.animTimer = null;
    this.animating = false;
    this.dragTimer = null;
    this.pollTimer = null;
    this.streamTicks = 0;
  }

  // MARK: plumbing

  send(msg) { if (!this.win.isDestroyed()) this.win.webContents.send('ui', msg); }
  banner(text, tone = 'info') { this.send({ type: 'banner', text, tone }); }
  busy(text, pairing = false) { this.send({ type: 'busy', text, pairing }); }
  toast(text, kind = null, autoHide = 0) { this.send({ type: 'toast', text, kind, autoHide }); }
  setMode(mode) { this.mode = mode; this.send({ type: 'mode', mode }); }

  get workArea() { return screen.getDisplayMatching(this.win.getBounds()).workArea; }
  get aspect() { return aspectOf(this.videoSize); }
  get reducedMotion() {
    try { return systemPreferences.getAnimationSettings().prefersReducedMotion; } catch { return false; }
  }

  // MARK: launch

  start() {
    this.applyKeepOnTop();
    this.updateAspect();
    this.resizeToWidth(BASE_SHORT_SIDE, false);
    this.centerOnPointerScreen();
    this.win.on('resize', () => { if (!this.animating) this.targetWidth = this.win.getBounds().width; });
    this.win.on('focus', () => this.send({ type: 'focus', active: true }));
    this.win.on('blur', () => { this.send({ type: 'focus', active: false }); this.endWindowDrag(); });
    this.pollTimer = setInterval(() => this.tick(), 1500);
  }

  /** The renderer asks for everything it needs to draw the first screen. */
  rendererReady() {
    this.send({ type: 'init', prefs: this.prefs.all(), accent: this.accent(), devices: this.devices });
    if (!findAdb()) this.banner(ADB_MISSING, 'error');
    this.tick();
  }

  /** The Windows accent colour as #rrggbb, or null when the system does not give one. */
  accent() {
    try {
      const c = systemPreferences.getAccentColor();
      return typeof c === 'string' && c.length >= 6 ? `#${c.slice(0, 6)}` : null;
    } catch { return null; }
  }

  async shutdown() {
    clearInterval(this.pollTimer);
    clearInterval(this.animTimer);
    this.endWindowDrag();
    await this.session?.stop(500);  // wakes the phone screen if we turned it off
  }

  /** Opens on the display the pointer is on, centred in its usable area. */
  centerOnPointerScreen() {
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const b = this.win.getBounds();
    this.win.setBounds({
      x: Math.round(wa.x + (wa.width - b.width) / 2),
      y: Math.round(wa.y + (wa.height - b.height) / 2),
      width: b.width, height: b.height,
    });
  }

  // MARK: always on top

  applyKeepOnTop() { this.win.setAlwaysOnTop(this.prefs.get('keepOnTop'), 'floating'); }

  toggleKeepOnTop() {
    this.prefs.set('keepOnTop', !this.prefs.get('keepOnTop'));
    this.applyKeepOnTop();
    this.send({ type: 'prefs', prefs: this.prefs.all() });
  }

  // MARK: window sizing

  maxWidth() { return maxWidthFor(this.aspect, this.workArea); }

  updateAspect() {
    const a = this.aspect;
    this.win.setAspectRatio(1 / a);
    const minW = Math.round(minWidthFor(a));
    this.win.setMinimumSize(minW, Math.round(minW * a));
  }

  /** Resizes to `width` (clamped), keeping the phone's aspect ratio and top-left corner, and keeping the window on screen. */
  resizeToWidth(width, animated) {
    const target = frameForWidth(this.win.getBounds(), width, this.aspect, this.workArea);
    this.targetWidth = target.width;
    if (animated && !this.reducedMotion) {
      this.animateFrame(target);
    } else {
      clearInterval(this.animTimer);
      this.animating = false;
      this.win.setBounds(target);
    }
  }

  /** Our own ease-out animation: interruptible, keeps the aspect ratio every frame. */
  animateFrame(target) {
    clearInterval(this.animTimer);
    const from = this.win.getBounds();
    const aspect = this.aspect;
    const t0 = performance.now();
    this.animating = true;
    this.animTimer = setInterval(() => {
      if (this.win.isDestroyed()) { clearInterval(this.animTimer); return; }
      const p = Math.min(1, (performance.now() - t0) / 340);
      this.win.setBounds(interpolateFrame(from, target, p, aspect));
      if (p >= 1) { clearInterval(this.animTimer); this.animTimer = null; this.animating = false; }
    }, 8);
  }

  zoomIn() { this.resizeToWidth(this.targetWidth * 1.15, true); }
  zoomOut() { this.resizeToWidth(this.targetWidth / 1.15, true); }
  actualSize() { this.resizeToWidth(baseWidthFor(this.aspect), true); }

  /** Fit button: grow to the biggest size that fits the screen, then back to where it was. */
  toggleZoom() {
    const maxW = this.maxWidth();
    if (this.targetWidth >= maxW - 2 && this.restoreWidth) {
      const r = this.restoreWidth;
      this.restoreWidth = null;
      this.resizeToWidth(r, true);
    } else {
      if (this.targetWidth < maxW - 2) this.restoreWidth = this.targetWidth;
      this.resizeToWidth(maxW, true);
    }
  }

  // Dragging the window by its own surfaces. Native drag regions swallow mouse events (which the auto-hiding controls
  // rely on), so the window is moved by following the cursor instead.
  beginWindowDrag() {
    this.endWindowDrag();
    const start = screen.getCursorScreenPoint();
    const b = this.win.getBounds();
    this.animating = false;
    clearInterval(this.animTimer);
    this.dragTimer = setInterval(() => {
      if (this.win.isDestroyed()) { this.endWindowDrag(); return; }
      const p = screen.getCursorScreenPoint();
      // setBounds with the original size (not setPosition) so display scaling can never nudge the size
      this.win.setBounds({ x: b.x + p.x - start.x, y: b.y + p.y - start.y, width: b.width, height: b.height });
    }, 8);
  }
  endWindowDrag() { clearInterval(this.dragTimer); this.dragTimer = null; }

  // MARK: device discovery

  tick() {
    // While streaming, a dropped phone also ends the stream itself, so look only every third tick.
    if (this.mode === 'streaming' && ++this.streamTicks % 3 !== 0) return;
    const adb = findAdb();
    if (this.polling || !adb) return;
    this.polling = true;
    const gen = this.generation;  // a poll that began before a session started must not judge that session
    listDevices(adb).then((list) => {
      this.polling = false;
      if (!list) return;
      this.devices = list;
      this.send({ type: 'devices', devices: list });
      const s = this.session;
      if (gen === this.generation && s && !list.some((d) => d.serial === s.serial && d.state === 'device')) {
        this.endSession('The phone was disconnected.', 'info');
      }
    });
  }

  // MARK: connecting

  async connect(raw) {
    const adb = findAdb();
    if (!adb) return this.banner(ADB_MISSING, 'error');
    const addr = normalize(String(raw ?? ''));
    // Not an error: the person just hasn't typed an address yet.
    if (!addr) return this.banner("Enter your phone's address, like 192.168.0.101:42799.", 'info');
    this.prefs.set('lastAddress', addr);
    const gen = ++this.generation;
    this.busy(`Connecting to ${addr}…`);
    const { ok, out } = await adbConnect(adb, addr);
    if (gen !== this.generation) return;
    if (ok) {
      this.startSession(addr);
    } else {
      this.busy(null);
      this.banner(out || `Could not reach ${addr}.`, 'error');
    }
  }

  async pair(rawAddr, rawCode) {
    const adb = findAdb();
    if (!adb) return this.banner(ADB_MISSING, 'error');
    const addr = String(rawAddr ?? '').trim();
    const pin = String(rawCode ?? '').trim();
    // Pairing needs the pairing port (shown on the phone), so an address without one is not enough.
    if (!addr.includes(':') || !normalize(addr)) return this.banner('Enter the pairing address with its port, like 192.168.0.101:37123.', 'info');
    if (!/^[0-9]{6}$/.test(pin)) return this.banner('The pairing code is the 6 digits shown on the phone.', 'info');
    const gen = ++this.generation;
    this.busy('Pairing…', true);
    const { ok, address } = await adbPair(adb, addr, pin);
    if (gen !== this.generation) return;
    this.busy(null);
    // adb's own wording ("protocol fault…") means little to most people, so say what to check instead.
    this.send({
      type: 'pairFinished',
      error: ok ? null : "Couldn't pair. Check the address and code on the phone; both change every time.",
      address,
    });
  }

  cancelConnect() {
    this.generation++;
    this.session?.stop();
    this.session = null;
    this.busy(null);
    this.banner('');
    this.setMode('connect');
  }

  // MARK: session

  startSession(serial) {
    this.session?.stop();  // a second click before the screen locked must not leave the first session running
    this.generation++;
    this.panelOpen = false;
    this.busy('Connecting…');
    const sid = ++this.sid;
    const win = this.win;
    const s = new MirrorSession({ serial, audio: this.prefs.get('audioOnPc') }, {
      onEvent: (e) => {
        if (this.session !== s) return;
        if (e.type === 'size') { if (e.width > 0 && e.height > 0) this.phoneResized({ width: e.width, height: e.height }); }
        else if (e.type === 'meta') this.send({ type: 'meta', sid, name: e.name });
        else if (e.type === 'ended') {
          // null = the stream simply ended (informational); text = something actually went wrong
          this.endSession(e.reason ?? 'The connection to the phone was closed.', e.reason == null ? 'info' : 'error');
        }
      },
      onVideo: (p) => { if (this.session === s && !win.isDestroyed()) win.webContents.send('video', { sid, ...p }); },
      onAudio: (pcm) => { if (this.session === s && !win.isDestroyed()) win.webContents.send('audio', { sid, pcm }); },
    });
    this.session = s;
    this.send({ type: 'session', sid, audio: this.prefs.get('audioOnPc') });
    s.start();
  }

  /** The renderer decoded and drew the first frame: now the mirror can replace the connect screen. */
  firstFrame(sid) {
    const s = this.session;
    if (!s || sid !== this.sid || this.shownSid === sid) return;
    this.shownSid = sid;  // once per session; a reconnect (switching the sound route, say) is a new session
    this.setMode('streaming');
    if (this.prefs.get('phoneScreenOff')) s.setPhoneScreen(false);
  }

  /** Frame size as seen by the decoder; only trusted when the server never sends session packets. */
  frameSize(sid, width, height) {
    const s = this.session;
    if (!s || sid !== this.sid || s.sawSessionPacket) return;
    if (width > 0 && height > 0) this.phoneResized({ width, height });
  }

  decodeFailed(sid, message) {
    if (sid !== this.sid || !this.session) return;
    this.endSession(`This PC could not decode the video (${message}).`, 'error');
  }

  phoneResized(size) {
    if (size.width === this.videoSize.width && size.height === this.videoSize.height) return;
    const wasPortrait = this.videoSize.height >= this.videoSize.width;
    this.videoSize = size;
    this.send({ type: 'size', ...size });
    this.updateAspect();
    const isPortrait = size.height >= size.width;
    const b = this.win.getBounds();
    // On rotation, swap the window's long and short sides so it stays comfortable.
    const width = isPortrait === wasPortrait ? b.width : b.height;
    this.resizeToWidth(width, this.mode === 'connect');
  }

  /** The connect screen is designed for a portrait phone; after a landscape session, go back to that shape. */
  resetAspectForConnect() {
    if (this.videoSize.width === DEFAULT_VIDEO.width && this.videoSize.height === DEFAULT_VIDEO.height) return;
    this.videoSize = { ...DEFAULT_VIDEO };
    this.send({ type: 'size', ...this.videoSize });
    this.updateAspect();
    this.resizeToWidth(Math.max(minWidthFor(this.aspect), BASE_SHORT_SIDE), false);
  }

  endSession(message, tone = 'error') {
    this.session?.stop();
    this.session = null;
    this.resetAspectForConnect();
    this.busy(null);
    this.banner(message, tone);
    this.setMode('connect');
  }

  // MARK: files dropped on the window

  async sendFiles(paths) {
    const serial = this.session?.serial;
    if (!serial || !Array.isArray(paths) || paths.length === 0) return;
    this.toast('Sending…', 'busy');
    const r = await sendFiles(paths.map(String), serial, (text) => this.toast(text, 'busy'));
    if (r.failures.length > 0) {
      const more = r.failures.length > 1 ? ` (+${r.failures.length - 1} more)` : '';
      this.toast(`Couldn't send ${r.failures[0]}${more}`, 'error', 7);
    } else {
      this.toast(summary(r), 'ok', 3.5);
    }
  }

  // MARK: sound and phone screen

  setAudio(onPc) {
    if (onPc === this.prefs.get('audioOnPc')) return;
    this.prefs.set('audioOnPc', onPc);
    this.send({ type: 'prefs', prefs: this.prefs.all() });
    // The sound route is chosen when the server starts, so a live session reconnects (about a second).
    const serial = this.session?.serial;
    if (serial && this.mode === 'streaming') {
      this.session.stop();
      this.session = null;
      this.startSession(serial);
    }
  }

  /** Turns the phone's screen off/on. The choice is remembered and applied to the next session too. */
  togglePhoneScreenOff() {
    const off = !this.prefs.get('phoneScreenOff');
    this.prefs.set('phoneScreenOff', off);
    this.session?.setPhoneScreen(!off);
    this.send({ type: 'prefs', prefs: this.prefs.all() });
    if (this.mode === 'streaming') this.toast(off ? 'Phone screen off' : 'Phone screen on', 'ok', 2);
  }

  // MARK: actions and input

  goHome() { this.panelOpen = false; this.session?.tapKey(Key.home); }
  appSwitcher() { this.panelOpen = false; this.session?.tapKey(Key.appSwitch); }
  goBack() { this.panelOpen = false; this.session?.send(Ctl.backOrScreenOn(0)); this.session?.send(Ctl.backOrScreenOn(1)); }
  /** Opens the phone's notification panel; the same control closes it again. */
  notifications() {
    if (!this.session) return;
    this.panelOpen = !this.panelOpen;
    this.session.send(Ctl.simple(this.panelOpen ? Ctl.expandNotifications : Ctl.collapsePanels));
  }
  disconnect() { if (this.session) this.endSession(''); }

  /** Input from the mirror surface. */
  input(m) {
    const s = this.session;
    if (!s || !m) return;
    const n = (v) => Math.trunc(Number(v) || 0);
    switch (m.t) {
      case 'touch': {
        const down = m.action !== 1;
        s.send(Ctl.touch({ action: n(m.action), x: n(m.x), y: n(m.y), w: n(m.w), h: n(m.h), pressure: down ? 1 : 0, buttons: down ? 1 : 0 }));
        break;
      }
      case 'scroll':
        s.send(Ctl.scroll({ x: n(m.x), y: n(m.y), w: n(m.w), h: n(m.h), hscroll: Number(m.hscroll) || 0, vscroll: Number(m.vscroll) || 0 }));
        break;
      case 'resetVideo': s.send(Ctl.simple(Ctl.resetVideo)); break;  // the decoder lost its place and wants a key frame
      case 'text': s.sendText(String(m.text ?? '')); break;
      case 'key': { const code = KEYS[m.name]; if (code) s.tapKey(code); break; }
      case 'back':  // right click / Esc
        if (m.action === 0) this.panelOpen = false;
        s.send(Ctl.backOrScreenOn(m.action === 1 ? 1 : 0));
        break;
      case 'swipe': {
        const open = panelAfterSwipe(Number(m.from), Number(m.to));
        if (open !== null) this.panelOpen = open;
        break;
      }
      case 'paste': {
        const text = clipboard.readText();
        if (text) s.send(Ctl.clipboard(text, true));
        break;
      }
      default: break;
    }
  }

  /** Named commands from buttons, menus and shortcuts. */
  act(name) {
    switch (name) {
      case 'home': return this.goHome();
      case 'switcher': return this.appSwitcher();
      case 'notifications': return this.notifications();
      case 'back': return this.goBack();
      case 'disconnect': return this.disconnect();
      case 'togglePhoneScreenOff': return this.togglePhoneScreenOff();
      case 'toggleKeepOnTop': return this.toggleKeepOnTop();
      case 'zoomIn': return this.zoomIn();
      case 'zoomOut': return this.zoomOut();
      case 'actualSize': return this.actualSize();
      case 'toggleZoom': return this.toggleZoom();
      case 'minimize': return this.win.minimize();
      case 'close': return this.win.close();
      default: return undefined;
    }
  }
}
