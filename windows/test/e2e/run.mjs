// End-to-end test: the real Electron app against a fake adb and a fake scrcpy-server that streams real H.264.
//
//   npx electron test/e2e/run.mjs            (needs ffmpeg with libx264 to make the test video)
//
// Drives the real window with synthetic input and checks what the "phone" receives. Screenshots go to $SHOT_DIR.

import { app, BrowserWindow } from 'electron';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-e2e-'));
const shotDir = process.env.SHOT_DIR || path.join(tmp, 'shots');
fs.mkdirSync(shotDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 8000, what = 'condition') => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
};

// ---------------------------------------------------------------- test video: 600x1000, a different aspect than the default

const VW = 600, VH = 1000;
const h264 = path.join(tmp, 'test.h264');
{
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${VW}x${VH}:rate=30:duration=2`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '1',
    '-x264-params', 'keyint=15:min-keyint=15:scenecut=0:bframes=0:repeat-headers=1:aud=0',
    '-pix_fmt', 'yuv420p', '-f', 'h264', h264], { encoding: 'utf8' });
  if (r.status !== 0) { console.error('ffmpeg failed:', r.stderr); app.exit(2); }
}

/** Splits an Annex B stream into access units (one per picture: all of its slices, with any parameter sets in front). */
function accessUnits(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      starts.push(i);
      i += buf[i + 2] === 1 ? 2 : 3;
    }
  }
  const nals = starts.map((s, k) => buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length));
  const units = [];
  let pending = [];
  let cur = null;
  for (const n of nals) {
    const off = n[2] === 1 ? 3 : 4;
    const type = n[off] & 0x1f;
    if (type === 1 || type === 5) {
      const firstSlice = (n[off + 1] & 0x80) !== 0;  // first_mb_in_slice == 0 starts a new picture
      if (firstSlice || !cur) { cur = { key: type === 5, parts: [...pending] }; units.push(cur); pending = []; }
      cur.parts.push(n);
    } else {
      pending.push(n);
    }
  }
  return units.map((u) => ({ key: u.key, data: Buffer.concat(u.parts) }));
}
const frames = accessUnits(fs.readFileSync(h264));

// ---------------------------------------------------------------- fake scrcpy-server

const server = { conns: 0, roles: [], control: Buffer.alloc(0), sockets: [], timer: null, sent: 0 };
const tcp = net.createServer((s) => {
  server.sockets.push(s);
  const audio = server.audioWanted;
  const idx = server.conns++;
  const role = idx === 0 ? 'video' : (audio && idx === 1 ? 'audio' : 'control');
  server.roles.push(role);
  s.on('error', () => {});
  if (role === 'video') {
    s.write(Buffer.from([0]));
    const name = Buffer.alloc(64); name.write('Test Phone');
    s.write(name);
    s.write(Buffer.from('h264'));
    const session = Buffer.alloc(12); session[0] = 0x80; session.writeUInt32BE(VW, 4); session.writeUInt32BE(VH, 8);
    s.write(session);
    let i = 0;
    clearInterval(server.timer);
    server.timer = setInterval(() => {
      if (s.destroyed) { clearInterval(server.timer); return; }
      const f = frames[i % frames.length];
      const hdr = Buffer.alloc(12);
      hdr.writeBigUInt64BE((f.key ? 1n << 61n : 0n) | BigInt(server.sent * 33333));
      hdr.writeUInt32BE(f.data.length, 8);
      s.write(Buffer.concat([hdr, f.data]));
      i++; server.sent++;
    }, 33);
  } else if (role === 'audio') {
    const codec = Buffer.alloc(4); codec.writeUInt32BE(0x00726177);
    s.write(codec);
    const t = setInterval(() => {
      if (s.destroyed) { clearInterval(t); return; }
      const pcm = Buffer.alloc(1920 * 4);  // 20 ms of a 440 Hz tone
      for (let n = 0; n < 1920; n++) { const v = Math.round(Math.sin((2 * Math.PI * 440 * (server.audioSamples + n)) / 48000) * 8000); pcm.writeInt16LE(v, n * 4); pcm.writeInt16LE(v, n * 4 + 2); }
      server.audioSamples += 1920;
      const hdr = Buffer.alloc(12); hdr.writeUInt32BE(pcm.length, 8);
      s.write(Buffer.concat([hdr, pcm]));
    }, 20);
  } else {
    s.on('data', (d) => { server.control = Buffer.concat([server.control, d]); });
  }
});
server.audioSamples = 0;
await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
const port = tcp.address().port;

/** Parses the control stream the app wrote into messages. */
function controlMessages() {
  const b = server.control, out = [];
  let o = 0;
  while (o < b.length) {
    const t = b[o];
    const len = { 0: 14, 2: 32, 3: 21, 4: 2, 5: 1, 7: 1, 10: 2, 17: 1 }[t]
      ?? (t === 1 ? 5 + b.readUInt32BE(o + 1) : t === 9 ? 14 + b.readUInt32BE(o + 10) : 0);
    if (!len || o + len > b.length) break;
    const m = b.subarray(o, o + len);
    if (t === 0) out.push({ t: 'key', action: m[1], code: m.readUInt32BE(2) });
    else if (t === 1) out.push({ t: 'text', text: m.subarray(5).toString('utf8') });
    else if (t === 2) out.push({ t: 'touch', action: m[1], x: m.readInt32BE(10), y: m.readInt32BE(14), w: m.readUInt16BE(18), h: m.readUInt16BE(20) });
    else if (t === 3) out.push({ t: 'scroll', x: m.readInt32BE(1), y: m.readInt32BE(5), h: m.readInt16BE(13), v: m.readInt16BE(15) });
    else if (t === 4) out.push({ t: 'back', action: m[1] });
    else if (t === 5) out.push({ t: 'expand' });
    else if (t === 7) out.push({ t: 'collapse' });
    else if (t === 10) out.push({ t: 'display', on: m[1] === 1 });
    else if (t === 17) out.push({ t: 'resetVideo' });
    else out.push({ t: `type${t}` });
    o += len;
  }
  return out;
}

// ---------------------------------------------------------------- fake adb

const adb = path.join(tmp, 'adb');
const adbLog = path.join(tmp, 'adb.log');
fs.writeFileSync(adb, `#!/bin/sh
echo "$@" >> "${adbLog}"
case "$*" in
  "devices -l") printf 'List of devices attached\\nFAKE1\\tdevice usb:1-1 product:x model:Test_Phone device:y transport_id:1\\nFAKE2\\tunauthorized usb:1-2 transport_id:2\\n';;
  *" forward tcp:0 "*) echo ${port};;
  *" shell "*) exec sleep 120;;
  "connect "*) echo "failed to connect to '$2': Connection refused";;
  *) ;;
esac
exit 0
`, { mode: 0o755 });
const jar = path.join(tmp, 'scrcpy-server');
fs.writeFileSync(jar, 'jar');
process.env.AM_ADB = adb;
process.env.AM_SCRCPY_SERVER = jar;
process.env.AM_SCRCPY_VERSION = '5.0.1';
app.setPath('userData', path.join(tmp, 'userData'));

// ---------------------------------------------------------------- run

let win;
const errors = [];
const js = (code) => win.webContents.executeJavaScript(code);
const shot = async (name) => {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(shotDir, `${name}.png`), img.toPNG());
};
const bounds = () => win.getBounds();
const mouse = (type, x, y, extra = {}) => win.webContents.sendInputEvent({
  type, x, y, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }), ...extra,
});

async function main() {
  await import(path.join(root, 'src', 'main', 'main.js'));
  await until(() => BrowserWindow.getAllWindows().length > 0, 10000, 'window');
  win = BrowserWindow.getAllWindows()[0];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`));
  await until(() => js('document.readyState === "complete"'), 10000, 'page load');
  await sleep(600);

  // ---- connect screen
  let b = bounds();
  check('window opens phone-shaped at 340 wide', b.width === 340 && b.height === 756, `${b.width}x${b.height}`);
  check('window stays on top by default', win.isAlwaysOnTop() === true);
  await until(async () => (await js('document.querySelectorAll(".device").length')) === 2, 6000, 'device polling');
  check('devices from adb are listed (ready + unauthorized)', true);
  check('unauthorized phone is not clickable and says what to do',
    await js('(() => { const r = [...document.querySelectorAll(".device")]; return r[1].tagName === "DIV" && r[1].textContent.includes("Allow on phone"); })()'));
  await shot('01-connect');

  await js('window.__ui.handlers.banner({text:"The phone was disconnected.", tone:"info"})');
  await js('document.querySelector("#pairToggle").click()');
  await sleep(600);
  await js('window.__ui.handlers.banner({text:"Couldn\'t pair. Check the address and code on the phone; both change every time.", tone:"error"})');
  await sleep(250);  // let the page paint before the picture is taken
  await shot('02-pair-page');
  check('pair page opens', await js('!document.querySelector("#pairPage").hidden && document.querySelector("#mainPage").hidden'));
  check('the pair error banner is visible with its text', await js('(() => { const b = document.querySelector("#pairBanner"); const r = b.getBoundingClientRect(); return !b.hidden && r.height > 20 && getComputedStyle(b).opacity === "1" && b.textContent.includes("Couldn"); })()'),
    await js('(() => { const b = document.querySelector("#pairBanner"); return `hidden=${b.hidden} h=${b.getBoundingClientRect().height} text=${JSON.stringify(b.textContent.slice(0,30))}`; })()'));
  await js('document.querySelector("#backBtn").click()');
  await sleep(700);
  check('back on the connect page it is actually visible (not left transparent by the fade)',
    await js('(() => { const p = document.querySelector("#mainPage"); return !p.hidden && getComputedStyle(p).opacity === "1" && p.getBoundingClientRect().height > 300; })()'),
    await js('getComputedStyle(document.querySelector("#mainPage")).opacity'));

  // a failed manual connect shows adb's words
  await js('document.querySelector("#address").value = "192.168.0.50:1234"; document.querySelector("#connectBtn").click()');
  await until(() => js('document.querySelector("#banner").dataset.tone === "error" && !document.querySelector("#banner").hidden'), 6000, 'connect error');
  check('failed connect shows adb output in an error banner', (await js('document.querySelector("#banner .msg").textContent')).includes('Connection refused'));
  await shot('03-connect-error');

  // ---- start a session: click the ready device
  await js('document.querySelector(".device.ready").click()');
  await until(() => js('window.__ui.state.mode === "streaming"'), 10000, 'streaming mode');
  check('clicking a phone starts the session and reaches streaming', true);
  await sleep(1300);  // let the transition and the window morph settle
  b = bounds();
  const expectH = Math.round(b.width * VH / VW);
  check('window follows the phone aspect ratio (600x1000)', Math.abs(b.height - expectH) <= 1, `${b.width}x${b.height}, expected height ${expectH}`);
  check('server was started with a scid and the right roles', server.roles.slice(0, 2).join() === 'video,control', server.roles.join());

  // decoded picture really is on the canvas, and it is moving
  const sample = () => js(`(() => { const c = document.querySelector("#video"); const x = c.getContext("2d"); const px = [];
    for (const [fx, fy] of [[.1,.1],[.5,.2],[.9,.3],[.3,.6],[.7,.8],[.5,.95]]) px.push([...x.getImageData(Math.floor(c.width*fx), Math.floor(c.height*fy), 1, 1).data].join(","));
    return { w: c.width, h: c.height, px }; })()`);
  const s1 = await sample();
  check('canvas has the phone resolution', s1.w === VW && s1.h === VH, `${s1.w}x${s1.h}`);
  check('decoded picture has real content (several different colours)', new Set(s1.px).size >= 3, s1.px.join(' | '));
  const frameHash = () => js('(() => { const d = document.querySelector("#video").toDataURL("image/jpeg", 0.4); let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) | 0; return h; })()');
  const h1 = await frameHash();
  await sleep(700);
  const h2 = await frameHash();
  check('picture keeps updating (the test pattern has a running clock)', h1 !== h2, `${h1} vs ${h2}`);
  await shot('04-streaming');

  // ---- floating controls
  check('controls are visible right after connecting', await js('!document.querySelector("#bar").classList.contains("hidden")'));
  await sleep(3000);
  check('controls step aside after a moment', await js('document.querySelector("#bar").classList.contains("hidden")'));
  mouse('mouseMove', 170, 12);
  await sleep(500);
  check('moving to the top edge brings them back', await js('!document.querySelector("#bar").classList.contains("hidden")'));
  await shot('05-controls');

  // ---- touch mapping
  const c0 = controlMessages().length;
  b = bounds();
  const cx = Math.round(b.width / 2), cy = Math.round(b.height / 2);
  mouse('mouseMove', cx, cy);
  mouse('mouseDown', cx, cy);
  await sleep(40);
  mouse('mouseMove', cx, cy + 60, { modifiers: ['leftButtonDown'] });
  await sleep(60);
  mouse('mouseUp', cx, cy + 60);
  await sleep(300);
  const touches = controlMessages().slice(c0).filter((m) => m.t === 'touch');
  check('a click-drag sends down, move(s), up', touches.length >= 3 && touches[0].action === 0 && touches.at(-1).action === 1, touches.map((t) => t.action).join());
  check('touch carries the phone screen size (600x1000)', touches.every((t) => t.w === VW && t.h === VH));
  const k = VW / b.width;
  check('touch lands where the pointer is (centre -> 300,500)', Math.abs(touches[0].x - cx * k) <= 4 && Math.abs(touches[0].y - cy * k) <= 4, `${touches[0].x},${touches[0].y}`);
  check('dragging down moves the touch down the screen', touches.at(-1).y > touches[0].y + 40, `${touches[0].y} -> ${touches.at(-1).y}`);

  // ---- wheel, keys, text, shortcuts
  const c1 = controlMessages().length;
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -120 });
  await sleep(150);
  const scrolls = controlMessages().slice(c1).filter((m) => m.t === 'scroll');
  check('mouse wheel sends a scroll event with a vertical amount', scrolls.length >= 1 && scrolls[0].v !== 0, JSON.stringify(scrolls[0] ?? null));

  const c2 = controlMessages().length;
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(200);
  const keys = controlMessages().slice(c2);
  check('Enter is sent as key 66 (down+up)', keys.filter((m) => m.t === 'key' && m.code === 66).length === 2);
  check('Esc is sent as Back', keys.filter((m) => m.t === 'back').length === 2);

  const c3 = controlMessages().length;
  win.webContents.insertText('héllo 世界');
  await sleep(250);
  const texts = controlMessages().slice(c3).filter((m) => m.t === 'text').map((m) => m.text).join('');
  check('typed text (incl. non-ASCII) reaches the phone', texts === 'héllo 世界', JSON.stringify(texts));

  const c4 = controlMessages().length;
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '1', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '2', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '3', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '3', modifiers: ['control'] });
  await sleep(250);
  const sc = controlMessages().slice(c4);
  check('Ctrl+1 = Home, Ctrl+2 = App Switcher', sc.some((m) => m.t === 'key' && m.code === 3) && sc.some((m) => m.t === 'key' && m.code === 187));
  check('Ctrl+3 opens the notification panel', sc.some((m) => m.t === 'expand'));

  // a swipe from the top edge marks the panel open, so the bell then closes it
  mouse('mouseMove', cx, 4);
  mouse('mouseDown', cx, 4);
  mouse('mouseMove', cx, 200, { modifiers: ['leftButtonDown'] });
  await sleep(60);
  mouse('mouseUp', cx, 200);
  await sleep(200);
  const c5 = controlMessages().length;
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '3', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '3', modifiers: ['control'] });
  await sleep(200);
  check('after a pull-down from the top, the bell closes the panel', controlMessages().slice(c5).some((m) => m.t === 'collapse'));

  // ---- right click = back
  const c6 = controlMessages().length;
  mouse('mouseDown', cx, cy, { button: 'right' });
  mouse('mouseUp', cx, cy, { button: 'right' });
  await sleep(200);
  check('right click is Back', controlMessages().slice(c6).filter((m) => m.t === 'back').length === 2);

  // ---- menu
  mouse('mouseMove', 170, 10);
  await sleep(450);
  await js('document.querySelector("#moreBtn").click()');
  await sleep(300);
  check('the more menu opens', await js('!document.querySelector("#menu").hidden'));
  await shot('06-menu');
  await js('document.querySelector("[data-menu=phoneScreenOff]").click()');
  await sleep(300);
  check('"Phone Screen Off" turns the phone screen off', controlMessages().some((m) => m.t === 'display' && m.on === false));

  // ---- drop overlay and toast (visual only)
  await js('document.querySelector("#dropOverlay").classList.add("on")');
  await js('window.__ui.handlers.toast({text:"Sent 2 files to Downloads · Installed 1 app", kind:"ok", autoHide:0})');
  await sleep(500);
  await shot('07-drop-and-toast');
  await js('document.querySelector("#dropOverlay").classList.remove("on")');
  await js('window.__ui.handlers.toast({text:"Sending app-release.apk…", kind:"busy", autoHide:0})');
  await sleep(500);
  await shot('08-toast-busy');
  await js('window.__ui.handlers.toast({text:"x", kind:null, autoHide:0.01})');

  // ---- sound on the PC: the session reconnects with an audio channel
  server.audioWanted = true;
  server.conns = 0;  // the next session's sockets are numbered from the start again
  const rolesBefore = server.roles.length;
  await js('document.querySelector("#moreBtn").click()');
  await js('document.querySelector("[data-menu=pc]").click()');
  await until(() => server.roles.slice(rolesBefore).includes('audio'), 10000, 'audio channel');
  check('choosing "Play on PC" reconnects with an audio channel', true);
  await sleep(1200);
  check('the display-off choice is applied again by the reconnected session',
    controlMessages().filter((m) => m.t === 'display' && m.on === false).length >= 2,
    `${controlMessages().filter((m) => m.t === 'display' && m.on === false).length} display-off messages`);
  const audioAdbArgs = fs.readFileSync(adbLog, 'utf8');
  check('server was started with audio=true', /audio=true/.test(audioAdbArgs));

  // ---- zoom and fit
  const w0 = bounds().width;
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '=', modifiers: ['control'] });
  await sleep(700);
  const w1 = bounds().width;
  check('Ctrl + zooms in (about 15%)', w1 > w0 * 1.1 && w1 < w0 * 1.2, `${w0} -> ${w1}`);
  b = bounds();
  check('zoom keeps the aspect ratio', Math.abs(b.height - Math.round(b.width * VH / VW)) <= 1, `${b.width}x${b.height}`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '9', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '9', modifiers: ['control'] });
  await sleep(700);
  b = bounds();
  const wa = (await import('electron')).screen.getDisplayMatching(b).workArea;
  check('Fit grows the window to what fits on the screen', b.height <= wa.height && b.width <= wa.width && (b.height >= wa.height - 20 || b.width >= wa.width - 20), `${b.width}x${b.height} in ${wa.width}x${wa.height}`);
  await shot('09-fit');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '9', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '9', modifiers: ['control'] });
  await sleep(700);
  check('Fit again returns to the previous size', Math.abs(bounds().width - w1) <= 2, `${bounds().width} vs ${w1}`);

  // ---- dragging the window by the controls strip
  mouse('mouseMove', 170, 10);
  await sleep(400);
  const before = bounds();
  mouse('mouseMove', 120, 20);
  mouse('mouseDown', 120, 20);
  await sleep(50);
  // Electron cannot move the OS cursor from a test, so the drag follows whatever the cursor does (nothing): the window must stay put.
  mouse('mouseUp', 120, 20);
  await sleep(100);
  check('a click on the strip does not move or resize the window', JSON.stringify(bounds()) === JSON.stringify(before));

  // ---- disconnect
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'D', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'D', modifiers: ['control'] });
  await until(() => js('window.__ui.state.mode === "connect"'), 6000, 'back to connect');
  await sleep(1300);
  b = bounds();
  check('Disconnect returns to the connect screen at the portrait shape', b.height > b.width * 2, `${b.width}x${b.height}`);
  await sleep(500);
  check('the phone screen was turned back on when leaving',
    [...controlMessages()].reverse().find((m) => m.t === 'display')?.on === true,
    JSON.stringify([...controlMessages()].reverse().find((m) => m.t === 'display')));
  await shot('10-after-disconnect');

  check('no errors were logged by the page', errors.length === 0, errors.join(' | '));
}

const watchdog = setTimeout(() => { console.error('E2E timed out'); finish(2); }, 150_000);
function finish(code) {
  clearTimeout(watchdog);
  clearInterval(server.timer);
  for (const s of server.sockets) s.destroy();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shotDir}`);
  app.exit(code ?? (failed.length ? 1 : 0));
}

app.whenReady().then(() => main().then(() => finish(), async (e) => {
  console.error('E2E error:', e.message);
  try {
    console.error('  banner:', JSON.stringify(await js('(() => { const b = document.querySelector("#banner"); return b.hidden ? null : b.textContent; })()')));
    console.error('  mode:', await js('window.__ui.state.mode'), ' page errors:', JSON.stringify(errors));
    await shot('zz-failure');
  } catch { /* the page may be gone */ }
  finish(2);
}));
