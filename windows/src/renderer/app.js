// The page: draws the connect screen and the mirror, reports input, decodes video. All decisions live in the main process
// (controller.js); this file only reacts to what it is told and tells it what the person did.

import { applyIcons, icons } from './icons.js';
import { H264Decoder } from './h264.js';
import { PcmPlayer } from './audio.js';

const am = window.am;
const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const root = $('#root');
const connectEl = $('#connect');
const mirrorEl = $('#mirror');
const canvas = $('#video');
const kbd = $('#kbd');
const bar = $('#bar');

const state = {
  mode: 'connect',
  sid: 0,
  size: { width: 1080, height: 2400 },
  prefs: { audioOnPc: false, phoneScreenOff: false, keepOnTop: true },
  devices: [],
  locked: false,        // a connect or pair attempt is in progress
  onPairPage: false,
};

applyIcons();

// ============================================================ connect screen

const scaled = $('#scaled');

/** Everything is laid out at a fixed 340 x 640 design size and scaled to the window. */
function layoutConnect() {
  const w = innerWidth, h = innerHeight;
  const k = Math.max(0.6, Math.min(w / 340, h / 640));
  scaled.style.setProperty('--k', k);
  scaled.style.width = `${w / k}px`;
  scaled.style.height = `${h / k}px`;
}
addEventListener('resize', layoutConnect);
layoutConnect();

const address = $('#address');
const pairAddress = $('#pairAddress');
const pairCode = $('#pairCode');
const connectBtn = $('#connectBtn');
const pairBtn = $('#pairBtn');
const cancelBtn = $('#cancelBtn');
const pairToggle = $('#pairToggle');
const hero = $('#hero');

// Fields: a clear button appears while there is text.
for (const input of [address, pairAddress, pairCode]) {
  const clear = input.parentElement.querySelector('.clear');
  const refresh = () => { clear.hidden = input.value === '' || input.disabled; };
  input.addEventListener('input', refresh);
  clear.addEventListener('click', (e) => { e.preventDefault(); input.value = ''; refresh(); input.focus(); });
  input.refreshClear = refresh;
}

function connectTapped() {
  if (state.locked) return;
  if (address.value.trim() === '') address.focus();
  am.connect(address.value);
}
function pairTapped() {
  if (state.locked) return;
  if (pairAddress.value.trim() === '') { pairAddress.focus(); return; }
  if (pairCode.value.trim() === '') { pairCode.focus(); return; }
  am.pair(pairAddress.value, pairCode.value);
}
connectBtn.addEventListener('click', connectTapped);
pairBtn.addEventListener('click', pairTapped);
cancelBtn.addEventListener('click', () => am.cancel());
address.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connectTapped(); } });
pairAddress.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pairCode.focus(); } });
pairCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pairTapped(); } });
pairCode.addEventListener('input', () => { pairCode.value = pairCode.value.replace(/\D/g, '').slice(0, 6); });

// Sound: Phone | PC
const soundSeg = $('#soundSeg');
function renderSound() {
  const pc = state.prefs.audioOnPc;
  for (const b of soundSeg.querySelectorAll('button')) b.setAttribute('aria-checked', String((b.dataset.value === 'pc') === pc));
  $('#soundDetail').textContent = pc ? 'Plays on this PC' : 'Plays on your phone';
}
soundSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !state.locked) am.setAudio(b.dataset.value === 'pc');
});

// Banners
function showBanner(el, text, tone = 'info') {
  if (!text) { el.hidden = true; return; }
  const glyph = { error: icons.errorCircle, success: icons.okCircle, info: icons.infoCircle }[tone] ?? icons.infoCircle;
  el.dataset.tone = tone;
  el.querySelector('.ico').innerHTML = glyph;
  el.querySelector('.msg').textContent = text;
  el.hidden = false;
}
const banner = $('#banner');
const pairBanner = $('#pairBanner');
const showHere = (text, tone) => showBanner(state.onPairPage ? pairBanner : banner, text, tone);

// Busy: the default button shows an activity indicator and a progress label.
function setBusy(text, pairing = false) {
  const busy = text != null;
  state.locked = busy;
  for (const input of [address, pairAddress, pairCode]) { input.disabled = busy; input.refreshClear(); }
  for (const b of soundSeg.querySelectorAll('button')) b.disabled = busy;
  connectBtn.disabled = busy;
  pairBtn.disabled = busy;
  pairToggle.disabled = busy;
  connectBtn.querySelector('.text').textContent = busy && !pairing ? text : 'Connect';
  pairBtn.querySelector('.text').textContent = busy && pairing ? text : 'Pair';
  connectBtn.querySelector('.spinner').hidden = !(busy && !pairing);
  pairBtn.querySelector('.spinner').hidden = !(busy && pairing);
  cancelBtn.hidden = !(busy && !pairing);
  hero.classList.toggle('busy', busy && !pairing);
  if (busy) { banner.hidden = true; pairBanner.hidden = true; }
}

// Pair page: its own page pushed over the connect page, so nothing has to squeeze in below the other content.
const mainPage = $('#mainPage');
const pairPage = $('#pairPage');
let pageToken = 0;
function showPairPage(show) {
  if (show === state.onPairPage) return;
  state.onPairPage = show;
  const token = ++pageToken;
  const from = show ? mainPage : pairPage;
  const to = show ? pairPage : mainPage;
  showBanner(pairBanner, '');
  let fadeOut = null;
  const finish = () => {
    if (token !== pageToken) return;
    fadeOut?.cancel();  // a fill-forwards fade would otherwise keep the page transparent when it comes back
    from.hidden = true;
    to.hidden = false;
    $('#scroll').scrollTop = 0;
    (show ? pairAddress : address).focus();
    if (!reduceMotion()) to.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  };
  if (reduceMotion() || from.hidden) finish();
  else {
    fadeOut = from.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in-out', fill: 'forwards' });
    fadeOut.finished.then(finish, finish);
  }
}
pairToggle.addEventListener('click', () => showPairPage(true));
$('#backBtn').addEventListener('click', () => { if (state.locked) am.cancel(); showPairPage(false); });

function pairFinished(error, addr) {
  if (error) { showBanner(pairBanner, error, 'error'); pairCode.focus(); return; }
  pairCode.value = '';
  pairCode.refreshClear();
  if (addr) { address.value = addr; address.refreshClear(); }
  showBanner(banner, addr ? 'Paired. The address is filled in. Tap Connect.' : 'Paired. Now enter the address from the main Wireless debugging screen and tap Connect.', 'success');
  showPairPage(false);
}

// Device list
const devicesEl = $('#devices');
const readableSerial = (s) => {
  const i = s.indexOf('._adb-tls-connect._tcp');
  if (i < 0) return s;
  let core = s.slice(0, i);
  if (core.startsWith('adb-')) core = core.slice(4);
  return `Wireless · ${core}`;
};
function renderDevices() {
  devicesEl.replaceChildren();
  if (state.devices.length === 0) {
    const row = document.createElement('div');
    row.className = 'row empty';
    row.innerHTML = `<span data-icon="plug"></span><div class="texts"><span class="title">No phones found</span><span class="sub">Plug one in with USB, or use an address below.</span></div>`;
    applyIcons(row);
    devicesEl.append(row);
    return;
  }
  for (const d of state.devices) {
    const ready = d.state === 'device';
    const name = d.model || 'Android phone';
    const row = document.createElement(ready ? 'button' : 'div');
    row.className = `row device${ready ? ' ready' : ''}`;
    if (ready) { row.type = 'button'; row.setAttribute('aria-label', `${name}, connect`); }
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.innerHTML = icons.phoneBadge;
    const texts = document.createElement('span');
    texts.className = 'texts';
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    const s = document.createElement('span');
    s.className = 'serial';
    s.textContent = readableSerial(d.serial);
    s.title = d.serial;
    texts.append(n, s);
    const trail = document.createElement('span');
    if (ready) { trail.className = 'trail'; trail.innerHTML = icons.chevronRight; }
    else { trail.className = 'status'; trail.textContent = d.state === 'unauthorized' ? 'Allow on phone' : d.state[0].toUpperCase() + d.state.slice(1); }
    row.append(badge, texts, trail);
    if (ready) row.addEventListener('click', () => { if (!state.locked) am.pick(d.serial); });
    devicesEl.append(row);
  }
}
renderDevices();

// ============================================================ window dragging (by the surfaces that are not controls)

function startWindowDrag(e) {
  const target = e.currentTarget;
  am.dragStart();
  try { target.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  const end = () => {
    am.dragEnd();
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    target.removeEventListener('lostpointercapture', end);
  };
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
  target.addEventListener('lostpointercapture', end);
}

connectEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button, input, .card, label, .link')) return;
  startWindowDrag(e);
});
bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  startWindowDrag(e);
});

// ============================================================ floating controls

const actions = $('#actions');
let barShown = true;
let nearTop = false;
let touching = false;
let hideTimer = null;
const BAR_ZONE = 60 + 14;

function setBarVisible(visible) {
  if (visible === barShown) return;
  barShown = visible;
  bar.classList.toggle('hidden', !visible);
  bar.classList.toggle('shown', visible);
}
function scheduleHide(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (state.mode === 'streaming' && !nearTop && !menuOpen()) setBarVisible(false);
  }, ms);
}

root.addEventListener('pointermove', (e) => {
  if (state.mode !== 'streaming' || touching) return;
  if (e.clientY < BAR_ZONE) {
    clearTimeout(hideTimer);
    hideTimer = null;
    nearTop = true;
    setBarVisible(true);
  } else if (nearTop && hideTimer === null) {
    nearTop = false;
    scheduleHide(700);
  }
});
root.addEventListener('pointerleave', () => { if (state.mode === 'streaming') { nearTop = false; scheduleHide(500); } });

bar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) am.act(b.dataset.act);
  if (state.mode === 'streaming') kbd.focus({ preventScroll: true });  // typing must keep going to the phone
});

// The "more" menu
const menu = $('#menu');
const moreBtn = $('#moreBtn');
function menuOpen() { return !menu.hidden; }
function renderMenu() {
  const set = (name, on) => menu.querySelector(`[data-menu="${name}"]`).setAttribute('aria-checked', String(on));
  set('phone', !state.prefs.audioOnPc);
  set('pc', state.prefs.audioOnPc);
  set('phoneScreenOff', state.prefs.phoneScreenOff);
  set('keepOnTop', state.prefs.keepOnTop);
}
function openMenu() {
  renderMenu();
  menu.hidden = false;
  const b = moreBtn.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.left = `${clamp(b.right - w + 4, 8, innerWidth - w - 8)}px`;
  menu.style.top = `${b.bottom + 6}px`;
  menu.style.transformOrigin = 'top right';
}
function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  if (state.mode === 'streaming') { kbd.focus({ preventScroll: true }); if (!nearTop) scheduleHide(700); }
}
moreBtn.addEventListener('click', () => (menuOpen() ? closeMenu() : openMenu()));
menu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-menu]');
  if (!item) return;
  closeMenu();
  switch (item.dataset.menu) {
    case 'phone': am.setAudio(false); break;
    case 'pc': am.setAudio(true); break;
    case 'phoneScreenOff': am.act('togglePhoneScreenOff'); break;
    case 'keepOnTop': am.act('toggleKeepOnTop'); break;
    case 'disconnect': am.act('disconnect'); break;
  }
});
addEventListener('pointerdown', (e) => { if (menuOpen() && !e.target.closest('#menu, #moreBtn')) closeMenu(); }, true);
addEventListener('blur', () => { if (menuOpen()) closeMenu(); });

// ============================================================ toast and drop overlay

const toast = $('#toast');
let toastTimer = null;
function showToast({ text, kind, autoHide }) {
  clearTimeout(toastTimer);
  toast.dataset.kind = kind ?? '';
  toast.querySelector('.msg').textContent = text;
  toast.querySelector('.spinner').hidden = kind !== 'busy';
  const ico = toast.querySelector('.ico');
  ico.innerHTML = kind === 'ok' ? icons.okCircle : kind === 'error' ? icons.errorCircle : '';
  ico.hidden = !(kind === 'ok' || kind === 'error');
  toast.classList.add('on');
  if (autoHide > 0) toastTimer = setTimeout(() => toast.classList.remove('on'), autoHide * 1000);
}

const dropOverlay = $('#dropOverlay');
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (state.mode !== 'streaming' || !hasFiles(e)) return;
  dragDepth++;
  dropOverlay.classList.add('on');
});
addEventListener('dragover', (e) => {
  e.preventDefault();  // always: otherwise the browser would navigate to a dropped file
  if (e.dataTransfer) e.dataTransfer.dropEffect = state.mode === 'streaming' && hasFiles(e) ? 'copy' : 'none';
});
addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove('on');
});
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('on');
  if (state.mode === 'streaming' && e.dataTransfer?.files?.length) am.sendFiles(e.dataTransfer.files);
});

// ============================================================ mirror: video

const ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
let decoder = null;
let player = null;
let pendingFrame = null;
let rafId = 0;
let firstFrameSent = false;
let reportedSize = '';
let watchdog = null;

function drawLatest() {
  rafId = 0;
  const f = pendingFrame;
  pendingFrame = null;
  if (!f) return;
  const w = f.displayWidth, h = f.displayHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx2d.drawImage(f, 0, 0, w, h);
  f.close();
  const sizeKey = `${w}x${h}`;
  if (sizeKey !== reportedSize) { reportedSize = sizeKey; am.frameSize(state.sid, w, h); }
  if (!firstFrameSent) {
    firstFrameSent = true;
    clearTimeout(watchdog);
    am.firstFrame(state.sid);
  }
}

// Only the newest decoded frame is ever drawn: if drawing falls behind, older ones are dropped, so latency never builds up.
function onFrame(frame) {
  pendingFrame?.close();
  pendingFrame = frame;
  if (!rafId) rafId = requestAnimationFrame(drawLatest);
}

function teardownMedia() {
  clearTimeout(watchdog);
  decoder?.close();
  decoder = null;
  player?.stop();
  player = null;
  pendingFrame?.close();
  pendingFrame = null;
}

function beginSession(sid, audio) {
  teardownMedia();
  state.sid = sid;
  firstFrameSent = false;
  reportedSize = '';
  if (typeof VideoDecoder === 'undefined') { am.decodeFailed(sid, 'WebCodecs is not available'); return; }
  decoder = new H264Decoder({
    onFrame,
    onNeedKeyframe: () => am.input({ t: 'resetVideo' }),
    onFatal: (msg) => am.decodeFailed(sid, msg),
  });
  if (audio) { player = new PcmPlayer(); player.start(); }
}

am.onVideo((p) => { if (p.sid === state.sid) decoder?.push(p); });
am.onAudio((p) => { if (p.sid === state.sid) player?.enqueue(p.pcm); });

// ============================================================ mirror: input

/** Where the phone screen actually sits inside the view (aspect-fit), and the touch point for a pointer event. */
function devicePoint(e) {
  const r = mirrorEl.getBoundingClientRect();
  const s = state.size;
  const k = Math.min(r.width / s.width, r.height / s.height);
  const w = s.width * k, h = s.height * k;
  const ox = (r.width - w) / 2, oy = (r.height - h) / 2;
  const fx = clamp((e.clientX - r.left - ox) / Math.max(1, w), 0, 1);
  const fy = clamp((e.clientY - r.top - oy) / Math.max(1, h), 0, 1);
  return { x: fx * s.width, y: fy * s.height, fy };
}
const sendTouch = (action, p) => am.input({ t: 'touch', action, x: p.x, y: p.y, w: state.size.width, h: state.size.height });

let pressing = false;
let rightDown = false;
let gestureStartY = 0;
let pendingMove = null;
let moveRaf = 0;

function flushMove() {
  moveRaf = 0;
  if (pendingMove && pressing) sendTouch(2, pendingMove);
  pendingMove = null;
}

mirrorEl.addEventListener('pointerdown', (e) => {
  if (state.mode !== 'streaming') return;
  kbd.focus({ preventScroll: true });
  if (e.altKey && e.button === 0) { startWindowDrag({ currentTarget: mirrorEl, pointerId: e.pointerId }); return; }  // Alt-drag moves the window
  mirrorEl.setPointerCapture(e.pointerId);
  if (e.button === 2) { rightDown = true; am.input({ t: 'back', action: 0 }); return; }
  if (e.button !== 0) return;
  pressing = true;
  touching = true;
  nearTop = false;
  clearTimeout(hideTimer);
  hideTimer = null;
  setBarVisible(false);  // while a finger is down on the phone (pulling the notification panel, say) the controls step aside
  const p = devicePoint(e);
  gestureStartY = p.fy;
  sendTouch(0, p);
});
mirrorEl.addEventListener('pointermove', (e) => {
  if (!pressing) return;
  pendingMove = devicePoint(e);
  if (!moveRaf) moveRaf = requestAnimationFrame(flushMove);
});
function endPress(e) {
  if (rightDown && e.button === 2) { rightDown = false; am.input({ t: 'back', action: 1 }); return; }
  if (!pressing || e.button !== 0) return;
  pressing = false;
  touching = false;
  pendingMove = null;
  const p = devicePoint(e);
  am.input({ t: 'swipe', from: gestureStartY, to: p.fy });
  sendTouch(1, p);
}
mirrorEl.addEventListener('pointerup', endPress);
mirrorEl.addEventListener('pointercancel', (e) => {
  if (!pressing) return;
  pressing = false;
  touching = false;
  sendTouch(1, devicePoint(e));
});
mirrorEl.addEventListener('contextmenu', (e) => e.preventDefault());

mirrorEl.addEventListener('wheel', (e) => {
  if (state.mode !== 'streaming') return;
  e.preventDefault();
  // scrcpy's unit is one wheel notch. Browsers report ~100 px per notch (pixel mode) or lines.
  const unit = e.deltaMode === 0 ? 1 / 100 : e.deltaMode === 1 ? 1 : 10;
  const p = devicePoint(e);
  am.input({ t: 'scroll', x: p.x, y: p.y, w: state.size.width, h: state.size.height, hscroll: e.deltaX * unit, vscroll: -e.deltaY * unit });
}, { passive: false });

// Typed text arrives through the hidden input so that IME composition (Chinese, Japanese, Korean...) works too.
let composing = false;
const sendText = (t) => { if (t) am.input({ t: 'text', text: t }); };
kbd.addEventListener('compositionstart', () => { composing = true; });
kbd.addEventListener('compositionend', (e) => { composing = false; sendText(e.data); kbd.value = ''; });
kbd.addEventListener('input', (e) => {
  if (composing || e.isComposing) return;
  sendText(e.data ?? kbd.value);
  kbd.value = '';
});

const SPECIAL_KEYS = {
  Enter: 'enter', NumpadEnter: 'enter', Backspace: 'del', Delete: 'fwdDel', Tab: 'tab',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down', ArrowUp: 'up',
};

/** Ctrl shortcuts (the Cmd shortcuts of the Mac app). Returns true when handled. */
function shortcut(e) {
  const streaming = state.mode === 'streaming';
  if (e.altKey) {
    if (e.code === 'KeyL') { am.act('togglePhoneScreenOff'); return true; }
    if (e.code === 'KeyT') { am.act('toggleKeepOnTop'); return true; }
    return false;
  }
  switch (e.key) {
    case '1': am.act('home'); return true;
    case '2': am.act('switcher'); return true;
    case '3': am.act('notifications'); return true;
    case '[': am.act('back'); return true;
    case '0': am.act('actualSize'); return true;
    case '=': case '+': am.act('zoomIn'); return true;
    case '-': am.act('zoomOut'); return true;
    case '9': am.act('toggleZoom'); return true;
    case 'd': case 'D': am.act('disconnect'); return true;
    case 'w': case 'W': case 'q': case 'Q': am.act('close'); return true;
    case 'v': case 'V':
      if (!streaming) return false;  // on the connect screen Ctrl+V pastes into the field as usual
      am.input({ t: 'paste' });
      return true;
    default: return false;
  }
}

addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (shortcut(e)) e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && menuOpen()) { closeMenu(); e.preventDefault(); return; }
  if (state.mode !== 'streaming' || e.isComposing || composing || e.keyCode === 229) return;
  if (document.activeElement !== kbd) kbd.focus({ preventScroll: true });  // a click on a control may have taken the focus
  if (e.key === 'Escape') {
    e.preventDefault();
    am.input({ t: 'back', action: 0 });
    am.input({ t: 'back', action: 1 });
    return;
  }
  const name = SPECIAL_KEYS[e.code] ?? SPECIAL_KEYS[e.key];
  if (name) { e.preventDefault(); am.input({ t: 'key', name }); }
});

// ============================================================ connect <-> mirror

let modeToken = 0;

/**
 * Connect <-> mirroring, in the manner of an iOS app opening: the new screen zooms in from slightly smaller on a spring
 * with a hint of overshoot while the old one drifts toward the viewer and fades. Reversed on the way back.
 */
function setMode(m) {
  if (m === 'connect') teardownMedia();
  if (m === state.mode) return;
  state.mode = m;
  root.dataset.mode = m;
  touching = false;
  pressing = false;
  const token = ++modeToken;
  const streaming = m === 'streaming';
  const incoming = streaming ? mirrorEl : connectEl;
  const outgoing = streaming ? connectEl : mirrorEl;
  incoming.hidden = false;
  outgoing.hidden = false;
  incoming.style.zIndex = '2';
  outgoing.style.zIndex = '1';
  clearTimeout(hideTimer);
  hideTimer = null;
  actions.hidden = !streaming;
  closeMenu();
  setBarVisible(true);
  if (streaming) { scheduleHide(2400); kbd.focus({ preventScroll: true }); } else { nearTop = false; (state.onPairPage ? pairAddress : address).focus(); }

  const anims = [];
  const go = (el, frames, opts) => anims.push(el.animate(frames, { fill: 'forwards', ...opts }));
  if (reduceMotion()) {
    go(incoming, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    go(outgoing, [{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
  } else {
    const inStart = streaming ? 0.9 : 1.12;   // mirroring grows from smaller; connect settles back from larger
    const outEnd = streaming ? 1.16 : 0.92;   // connect flies toward you; mirroring recedes
    go(incoming, [{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' });
    go(incoming, [{ transform: `scale(${inStart})` }, { transform: 'scale(1)' }], { duration: 650, easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)' });
    go(outgoing, [{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: 'cubic-bezier(0.42, 0, 0.2, 1)' });
    go(outgoing, [{ transform: 'scale(1)' }, { transform: `scale(${outEnd})` }], { duration: 500, easing: 'cubic-bezier(0.42, 0, 0.2, 1)' });
  }
  setTimeout(() => {
    if (token !== modeToken) return;
    for (const a of anims) a.cancel();
    incoming.style.zIndex = '';
    outgoing.style.zIndex = '';
    outgoing.hidden = true;
  }, 1100);
}

// ============================================================ messages from the app

function applyAccent(hex) { if (hex) document.documentElement.style.setProperty('--accent', hex); }

const handlers = {
  init({ prefs, accent, devices }) {
    state.prefs = prefs;
    state.devices = devices;
    applyAccent(accent);
    address.value = prefs.lastAddress || '';
    address.refreshClear();
    renderSound();
    renderDevices();
    address.focus();
  },
  prefs({ prefs }) { state.prefs = prefs; renderSound(); if (menuOpen()) renderMenu(); },
  devices({ devices }) {
    if (JSON.stringify(devices) === JSON.stringify(state.devices)) return;
    state.devices = devices;
    renderDevices();
  },
  busy({ text, pairing }) { setBusy(text, pairing); },
  banner({ text, tone }) { showHere(text, tone); },
  pairFinished({ error, address: addr }) { pairFinished(error, addr); },
  toast(t) { showToast(t); },
  mode({ mode }) { setMode(mode); },
  size({ width, height }) { state.size = { width, height }; },
  session({ sid, audio }) { beginSession(sid, audio); },
  meta({ sid }) {
    if (sid !== state.sid) return;
    // The server is up; if no picture ever comes out of the decoder, say so instead of hanging on "Connecting…".
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { if (!firstFrameSent) am.decodeFailed(sid, 'no picture was received'); }, 8000);
  },
  focus({ active }) { root.classList.toggle('inactive', !active); },
};
am.onUi((msg) => handlers[msg.type]?.(msg));

// A small handle for tests and debugging.
window.__ui = { state, handlers, setMode };

am.ready();
