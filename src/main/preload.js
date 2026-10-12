'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Local path -> file:// URL (sandboxed preloads have no full `url` module). Handles Windows drives, UNC and unicode. */
function toFileUrl(p) {
  let s = String(p).replace(/\\/g, '/');
  const unc = s.startsWith('//');
  if (!unc && !s.startsWith('/')) s = `/${s}`;
  const encoded = s.split('/').map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/');
  return unc ? `file:${encoded}` : `file://${encoded}`;
}

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  setTheme: (t) => ipcRenderer.invoke('theme:set', t),
  openFiles: (kind, multi) => ipcRenderer.invoke('dialog:openFiles', kind, multi),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  probe: (p) => ipcRenderer.invoke('media:probe', p),
  frame: (p, t, w) => ipcRenderer.invoke('media:frame', p, t, w),
  preview: (kind, p, opts) => ipcRenderer.invoke('plan:preview', kind, p, opts),
  addJobs: (specs) => ipcRenderer.invoke('jobs:add', specs),
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  cancelJob: (id) => ipcRenderer.invoke('jobs:cancel', id),
  cancelAll: () => ipcRenderer.invoke('jobs:cancelAll'),
  clearJobs: () => ipcRenderer.invoke('jobs:clear'),
  retryJob: (id) => ipcRenderer.invoke('jobs:retry', id),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openFolder2: (p) => ipcRenderer.invoke('shell:openFolder', p),
  saveFile: (o) => ipcRenderer.invoke('dialog:saveFile', o),
  // screen recording
  displays: () => ipcRenderer.invoke('rec:displays'),
  recPrepare: (o) => ipcRenderer.invoke('rec:prepare', o),
  selectRegion: (o) => ipcRenderer.invoke('rec:selectRegion', o),
  recDir: () => ipcRenderer.invoke('rec:dir'),
  recSetDir: (d) => ipcRenderer.invoke('rec:setDir', d),
  recOpen: (ext) => ipcRenderer.invoke('rec:open', ext),
  recWrite: (id, data) => ipcRenderer.invoke('rec:write', id, data),
  recClose: (id) => ipcRenderer.invoke('rec:close', id),
  recDiscard: (id) => ipcRenderer.invoke('rec:discard', id),
  recStarted: (o) => ipcRenderer.invoke('rec:started', o),
  recStopped: () => ipcRenderer.invoke('rec:stopped'),
  recStatus: (s) => ipcRenderer.send('rec:status', s),
  onRecCommand: on('rec:command'),
  onJobUpdate: on('jobs:update'),
  onIdle: on('jobs:idle'),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  fileUrl: toFileUrl,
});
