'use strict';
/**
 * Desktop screen-recording support (main process):
 *  - display list + capture-source selection for getDisplayMedia (no system picker)
 *  - transparent region-selection overlay (one window per display)
 *  - floating control bar + click-through region frame while recording
 *  - temp-file sink so long recordings never live in renderer memory
 * The renderer owns the MediaRecorder; everything here is plumbing.
 */
const { BrowserWindow, screen, desktopCapturer, session, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

const AUX = path.join(__dirname, '..', 'renderer', 'aux');
const PRELOAD = path.join(__dirname, 'aux-preload.js');
const sinks = new Map(); // id -> { file, fh, size }
const recordedFiles = new Set(); // finished temp captures the queue may consume
let pending = null; // { displayId, systemAudio } for the next getDisplayMedia call
let pendingRegion = null;
let overlays = [];
let bar = null;
let frame = null;
let seq = 0;

const displayInfo = (d) => ({
  id: String(d.id),
  label: d.label || '',
  primary: d.id === screen.getPrimaryDisplay().id,
  bounds: d.bounds,
  scaleFactor: d.scaleFactor,
  pixels: { w: Math.round(d.bounds.width * d.scaleFactor), h: Math.round(d.bounds.height * d.scaleFactor) },
});
const findDisplay = (id) => screen.getAllDisplays().find((d) => String(d.id) === String(id)) || screen.getPrimaryDisplay();

function auxWindow(file, opts, query) {
  const w = new BrowserWindow({
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    ...opts,
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setMenu(null);
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.loadFile(path.join(AUX, file), { query });
  return w;
}

/* ------------------------------------------------------------ region overlay */
function closeOverlays() {
  const list = overlays;
  overlays = [];
  for (const w of list) if (!w.isDestroyed()) w.destroy();
}

function selectRegion(getWin, { displayId, theme } = {}) {
  closeOverlays();
  const main = getWin();
  if (main) main.hide();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      pendingRegion = null;
      closeOverlays();
      if (main && !main.isDestroyed()) {
        main.show();
        main.focus();
      }
      resolve(result);
    };
    const target = displayId ? String(displayId) : null;
    for (const d of screen.getAllDisplays()) {
      const info = displayInfo(d);
      const focus = !target || target === info.id || !screen.getAllDisplays().some((x) => String(x.id) === target);
      const w = auxWindow('region.html', { ...d.bounds, enableLargerThanScreen: true, movable: false, focusable: true }, {
        w: String(info.pixels.w), h: String(info.pixels.h), theme: theme === 'dark' ? 'dark' : 'light', focus: focus ? '1' : '0',
      });
      w.displayId = info.id;
      w.once('ready-to-show', () => {
        w.setBounds(d.bounds);
        w.show();
        if (focus) w.focus();
      });
      w.on('closed', () => {
        overlays = overlays.filter((o) => o !== w);
        if (!overlays.length) finish(null);
      });
      overlays.push(w);
    }
    pendingRegion = (sender, result) => {
      const w = overlays.find((o) => o.webContents === sender);
      if (!w) return;
      if (!result) return finish(null);
      const d = findDisplay(w.displayId);
      finish({ displayId: String(d.id), rect: result, scaleFactor: d.scaleFactor, bounds: d.bounds });
    };
  });
}

/* ------------------------------------------------------- recording chrome */
function closeChrome() {
  for (const w of [bar, frame]) if (w && !w.isDestroyed()) w.destroy();
  bar = null;
  frame = null;
}

function showChrome(getWin, { displayId, region, hideApp, theme }) {
  closeChrome();
  const d = findDisplay(displayId);
  const B = d.bounds;
  const W = 340;
  const H = 58;
  let y = B.y + 14;
  if (region) {
    const r = { x: B.x + region.x * B.width, y: B.y + region.y * B.height, w: region.w * B.width, h: region.h * B.height };
    // keep the bar off the captured area when there is room for it
    if (r.y - B.y < H + 24) y = r.y + r.h + H + 24 < B.y + B.height ? Math.round(r.y + r.h + 12) : B.y + B.height - H - 48;
    frame = auxWindow('frame.html', {
      x: Math.round(r.x) - 4, y: Math.round(r.y) - 4, width: Math.round(r.w) + 8, height: Math.round(r.h) + 8,
      focusable: false, movable: false, enableLargerThanScreen: true,
    }, {});
    frame.setIgnoreMouseEvents(true);
    frame.setContentProtection(true);
    frame.once('ready-to-show', () => frame && !frame.isDestroyed() && frame.showInactive());
  }
  bar = auxWindow('control.html', { x: Math.round(B.x + (B.width - W) / 2), y: Math.round(y), width: W, height: H, focusable: true },
    { theme: theme === 'dark' ? 'dark' : 'light' });
  bar.setContentProtection(true); // keep our own controls out of the video (Windows 10 2004+)
  bar.once('ready-to-show', () => bar && !bar.isDestroyed() && bar.showInactive());
  bar.on('closed', () => { bar = null; });
  const main = getWin();
  if (hideApp && main) main.minimize();
}

/* ---------------------------------------------------------------- wiring */
function register({ getWin, loadSettings, saveSettings, isStr }) {
  const defaultRecordDir = () => path.join(app.getPath('videos'), 'Media Yar');

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const p = pending;
    pending = null;
    const main = getWin();
    if (!p || !main || request.frame !== main.webContents.mainFrame) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const src = sources.find((s) => s.display_id && s.display_id === String(p.displayId)) || sources[0];
      if (!src) return callback({});
      const res = { video: src };
      if (p.systemAudio && request.audioRequested && process.platform === 'win32') res.audio = 'loopback';
      return callback(res);
    } catch {
      return callback({});
    }
  });

  ipcMain.handle('rec:displays', () => screen.getAllDisplays().map(displayInfo));
  ipcMain.handle('rec:prepare', (_e, o = {}) => {
    pending = { displayId: String(o.displayId || screen.getPrimaryDisplay().id), systemAudio: !!o.systemAudio };
    return true;
  });
  ipcMain.handle('rec:selectRegion', (_e, o) => selectRegion(getWin, o || {}));
  ipcMain.on('aux:region', (e, r) => {
    const ok = r && [r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1.0001) && r.w > 0 && r.h > 0;
    if (pendingRegion) pendingRegion(e.sender, ok ? { x: r.x, y: r.y, w: r.w, h: r.h } : null);
  });

  ipcMain.handle('rec:dir', () => {
    const s = loadSettings();
    const dir = isStr(s.recordDir) && fs.existsSync(s.recordDir) ? s.recordDir : defaultRecordDir();
    return { dir, isDefault: dir === defaultRecordDir() };
  });
  ipcMain.handle('rec:setDir', (_e, dir) => {
    if (!isStr(dir) || !fs.existsSync(dir)) return false;
    saveSettings({ recordDir: dir });
    return true;
  });

  // temp sink
  ipcMain.handle('rec:open', async (_e, ext) => {
    const e2 = ['webm', 'mp4', 'mkv'].includes(ext) ? ext : 'webm';
    const id = `r${++seq}`;
    const file = path.join(os.tmpdir(), `mediayar-rec-${Date.now().toString(36)}-${seq}.${e2}`);
    const fh = await fsp.open(file, 'w');
    sinks.set(id, { file, fh, size: 0 });
    return id;
  });
  ipcMain.handle('rec:write', async (_e, id, data) => {
    const s = sinks.get(id);
    if (!s || !data) return false;
    const buf = Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength);
    await s.fh.write(buf);
    s.size += buf.length;
    return true;
  });
  ipcMain.handle('rec:close', async (_e, id) => {
    const s = sinks.get(id);
    if (!s) return null;
    sinks.delete(id);
    await s.fh.close();
    recordedFiles.add(s.file);
    return { path: s.file, size: s.size };
  });
  ipcMain.handle('rec:discard', async (_e, idOrPath) => {
    const s = sinks.get(idOrPath);
    if (s) {
      sinks.delete(idOrPath);
      await s.fh.close().catch(() => {});
      await fsp.rm(s.file, { force: true });
    } else if (recordedFiles.has(idOrPath)) {
      recordedFiles.delete(idOrPath);
      await fsp.rm(idOrPath, { force: true });
    }
    return true;
  });

  // chrome during recording
  ipcMain.handle('rec:started', (_e, o = {}) => {
    showChrome(getWin, { displayId: o.displayId, region: o.region, hideApp: !!o.hideApp, theme: loadSettings().theme });
    return true;
  });
  ipcMain.handle('rec:stopped', () => {
    closeChrome();
    const main = getWin();
    if (main) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
    return true;
  });
  ipcMain.on('rec:status', (_e, status) => { if (bar && !bar.isDestroyed()) bar.webContents.send('aux:status', status); });
  ipcMain.on('aux:command', (_e, cmd) => {
    const main = getWin();
    if (['pause', 'resume', 'stop'].includes(cmd) && main) main.webContents.send('rec:command', cmd);
  });

  app.on('will-quit', () => {
    for (const s of sinks.values()) {
      try { s.fh.close(); fs.rmSync(s.file, { force: true }); } catch { /* ignore */ }
    }
  });

  return { isRecordedFile: (p) => recordedFiles.has(p), isRecording: () => !!bar };
}

module.exports = { register };
