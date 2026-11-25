// The only bridge between the page and the app. Preload scripts that are sandboxed must be CommonJS.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('am', {
  // page -> app
  ready: () => ipcRenderer.send('ready'),
  connect: (addr) => ipcRenderer.send('connect', addr),
  pair: (addr, code) => ipcRenderer.send('pair', addr, code),
  pick: (serial) => ipcRenderer.send('pick', serial),
  cancel: () => ipcRenderer.send('cancel'),
  setAudio: (onPc) => ipcRenderer.send('audio', onPc),
  act: (name) => ipcRenderer.send('act', name),
  input: (m) => ipcRenderer.send('input', m),
  sendFiles: (files) => ipcRenderer.send('files', Array.from(files, (f) => webUtils.getPathForFile(f)).filter(Boolean)),
  dragStart: () => ipcRenderer.send('dragStart'),
  dragEnd: () => ipcRenderer.send('dragEnd'),
  firstFrame: (sid) => ipcRenderer.send('firstFrame', sid),
  frameSize: (sid, w, h) => ipcRenderer.send('frameSize', sid, w, h),
  decodeFailed: (sid, message) => ipcRenderer.send('decodeFailed', sid, message),

  // app -> page
  onUi: (cb) => ipcRenderer.on('ui', (_e, msg) => cb(msg)),
  onVideo: (cb) => ipcRenderer.on('video', (_e, p) => cb(p)),
  onAudio: (cb) => ipcRenderer.on('audio', (_e, p) => cb(p)),
});
