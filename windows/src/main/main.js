// Android Mirroring for Windows — an iPhone-Mirroring-style front end for scrcpy.
// Electron main process: the window, IPC, and app lifecycle. The logic lives in controller.js.

import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prefs } from './prefs.js';
import { AppController } from './controller.js';
import { BASE_SHORT_SIDE, DEFAULT_VIDEO } from './windowing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

app.setAppUserModelId('local.android-mirroring');
app.setName('Android Mirroring');

// Wayland apps cannot place their own window or read the pointer outside it, which the frameless window's drag and
// zoom rely on. XWayland (and plain X11) allows both.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  /** @type {BrowserWindow | null} */
  let win = null;
  /** @type {AppController | null} */
  let controller = null;

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  Menu.setApplicationMenu(null);  // no menu bar: shortcuts live in the page, like the floating controls

  const createWindow = () => {
    const width = BASE_SHORT_SIDE;
    const height = Math.round((width * DEFAULT_VIDEO.height) / DEFAULT_VIDEO.width);
    win = new BrowserWindow({
      width, height,
      useContentSize: true,
      frame: false,
      show: false,
      resizable: true,
      maximizable: false,    // the Fit button grows the window to what fits; a real maximize would break the ratio
      fullscreenable: false, // full screen would add black bars
      backgroundColor: '#0a0a0c',
      title: 'Android Mirroring',
      icon: path.join(root, 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(here, '..', 'preload', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        autoplayPolicy: 'no-user-gesture-required',  // sound from the phone must start without a click
        backgroundThrottling: false,                 // keep decoding at full rate even when another window is on top
        spellcheck: false,
      },
    });

    const prefs = new Prefs(app.getPath('userData'));
    controller = new AppController(win, prefs);

    // Only our own page may be shown; links and new windows go to the default browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    win.loadFile(path.join(root, 'src', 'renderer', 'index.html'));
    win.once('ready-to-show', () => {
      controller.start();
      win.show();
    });
    win.on('closed', () => { win = null; });
  };

  // MARK: IPC — everything the page may ask for

  const guard = (fn) => (event, ...args) => {
    // Only our own window's page may drive the app.
    if (!win || event.sender !== win.webContents) return undefined;
    return fn(...args);
  };

  ipcMain.on('ready', guard(() => controller.rendererReady()));
  ipcMain.on('connect', guard((addr) => controller.connect(addr)));
  ipcMain.on('pair', guard((addr, code) => controller.pair(addr, code)));
  ipcMain.on('pick', guard((serial) => controller.startSession(String(serial))));
  ipcMain.on('cancel', guard(() => controller.cancelConnect()));
  ipcMain.on('audio', guard((onPc) => controller.setAudio(Boolean(onPc))));
  ipcMain.on('act', guard((name) => controller.act(String(name))));
  ipcMain.on('input', guard((m) => controller.input(m)));
  ipcMain.on('files', guard((paths) => controller.sendFiles(paths)));
  ipcMain.on('dragStart', guard(() => controller.beginWindowDrag()));
  ipcMain.on('dragEnd', guard(() => controller.endWindowDrag()));
  ipcMain.on('firstFrame', guard((sid) => controller.firstFrame(sid)));
  ipcMain.on('frameSize', guard((sid, w, h) => controller.frameSize(sid, w, h)));
  ipcMain.on('decodeFailed', guard((sid, message) => controller.decodeFailed(sid, String(message))));

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || !controller) return;
    // Give the phone a moment to hear "screen on" if we turned it off.
    e.preventDefault();
    quitting = true;
    controller.shutdown().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(createWindow);
}
