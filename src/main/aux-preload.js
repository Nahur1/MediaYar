'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aux', {
  region: (rect) => ipcRenderer.send('aux:region', rect),
  command: (cmd) => ipcRenderer.send('aux:command', cmd),
  onStatus: (cb) => ipcRenderer.on('aux:status', (_e, s) => cb(s)),
});
