'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Runner } = require('../core/runner');
const { NodeHost } = require('../core/node-host');
const { createService } = require('../core/service');
const F = require('../core/formats');
const recorder = require('./recorder');

const APP_NAME = 'Media Yar';
const ROOT = path.join(__dirname, '..', '..');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const THEME_BG = { light: '#FBF9FF', dark: '#15111E' };

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('ir.mediayar.app');

/* ------------------------------------------------------------ ffmpeg paths */
function resolveBinaries() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    process.env.MEDIAYAR_FFMPEG_DIR,
    app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : null,
    path.join(ROOT, 'vendor', 'ffmpeg'),
  ].filter(Boolean);
  for (const dir of candidates) {
    const ffmpeg = path.join(dir, `ffmpeg${exe}`);
    const ffprobe = path.join(dir, `ffprobe${exe}`);
    if (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) return { ffmpeg, ffprobe };
  }
  return { ffmpeg: `ffmpeg${exe}`, ffprobe: `ffprobe${exe}` }; // fall back to PATH
}

/* ---------------------------------------------------------------- settings */
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2));
  } catch { /* non-fatal */ }
  return next;
}

/* ------------------------------------------------------------------- state */
const runner = new Runner(resolveBinaries());
const service = createService(new NodeHost(runner));
const { queue } = service;
const producedFiles = new Set(); // outputs we created (allowed for shell.open)
let win = null;

const isStr = (s) => typeof s === 'string' && s.length > 0 && s.length < 4096;

/* ------------------------------------------------------------------ window */
function createWindow() {
  const settings = loadSettings();
  const theme = settings.theme === 'dark' ? 'dark' : 'light';
  nativeTheme.themeSource = theme;
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1020,
    minHeight: 680,
    show: false,
    title: 'مدیا یار',
    backgroundColor: THEME_BG[theme],
    icon: path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    const running = queue.list().some((j) => j.status === 'running' || j.status === 'queued') || (rec && rec.isRecording());
    if (!running || win.forceClose) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['خروج و لغو کارها', 'ادامه'],
      defaultId: 1,
      cancelId: 1,
      title: 'مدیا یار',
      message: 'هنوز کارهایی در حال انجام است.',
      detail: 'با خروج، تبدیل‌ها یا ضبط در حال انجام لغو می‌شوند.',
    });
    if (choice === 0) {
      win.forceClose = true;
      queue.cancelAll();
      win.close();
    }
  });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

queue.on('update', (job) => {
  if (job.status === 'done' && job.output) producedFiles.add(job.output);
  send('jobs:update', job);
  if (win && !win.isDestroyed()) {
    const p = queue.overall();
    win.setProgressBar(p < 0 ? -1 : Math.max(0.01, p));
  }
});
queue.on('idle', () => {
  if (win && !win.isDestroyed()) {
    win.setProgressBar(-1);
    if (!win.isFocused()) win.flashFrame(true);
  }
  send('jobs:idle', null);
});

/* --------------------------------------------------------------------- IPC */
const DIALOG_FILTERS = {
  video: [{ name: 'ویدیو', extensions: F.VIDEO_INPUT_EXT }, { name: 'همه فایل‌ها', extensions: ['*'] }],
  audio: [{ name: 'صوت و ویدیو', extensions: [...F.AUDIO_INPUT_EXT, ...F.VIDEO_INPUT_EXT] }, { name: 'همه فایل‌ها', extensions: ['*'] }],
};

let rec = null;
function registerIpc() {
  rec = recorder.register({ getWin: () => (win && !win.isDestroyed() ? win : null), loadSettings, saveSettings, isStr });
  ipcMain.handle('app:init', () => ({
    catalog: F.catalog(),
    theme: loadSettings().theme === 'dark' ? 'dark' : 'light',
    version: app.getVersion(),
    platform: process.platform,
    caps: {
      outputDir: true, reveal: true, download: false, share: false, fastFrames: true, defaultOut: 'کنار فایل اصلی',
      saveDialog: true, screenRecord: true, regionOverlay: true, hideApp: true, systemAudio: process.platform === 'win32',
    },
  }));

  // "Save as" for a single output: suggested folder + name, the user can change both.
  ipcMain.handle('dialog:saveFile', async (_e, o = {}) => {
    const ext = typeof o.ext === 'string' && /^[a-z0-9]{1,5}$/i.test(o.ext) ? o.ext.toLowerCase() : null;
    let dir = isStr(o.dir) ? o.dir : '';
    if (dir && !fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = ''; }
    }
    if (!dir) dir = app.getPath('videos');
    const clean = String(o.name || 'output').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || 'output';
    const stem = ext && clean.toLowerCase().endsWith(`.${ext}`) ? clean.slice(0, -(ext.length + 1)) : clean;
    let suggestion = path.join(dir, ext ? `${stem}.${ext}` : stem);
    for (let i = 2; fs.existsSync(suggestion) || (isStr(o.avoid) && path.resolve(suggestion) === path.resolve(o.avoid)); i++) {
      suggestion = path.join(dir, ext ? `${stem} (${i}).${ext}` : `${stem} (${i})`);
    }
    const r = await dialog.showSaveDialog(win, {
      title: String(o.title || 'ذخیره'),
      defaultPath: suggestion,
      buttonLabel: 'ذخیره',
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return null;
    let file = r.filePath;
    if (ext && path.extname(file).slice(1).toLowerCase() !== ext) file += `.${ext}`;
    return file;
  });

  ipcMain.handle('theme:set', (_e, theme) => {
    const t = theme === 'dark' ? 'dark' : 'light';
    nativeTheme.themeSource = t;
    if (win) win.setBackgroundColor(THEME_BG[t]);
    saveSettings({ theme: t });
    return t;
  });

  ipcMain.handle('dialog:openFiles', async (_e, kind, multi = true) => {
    const r = await dialog.showOpenDialog(win, {
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: DIALOG_FILTERS[kind] || DIALOG_FILTERS.video,
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('media:probe', (_e, file) => (isStr(file) ? service.probe(file) : { error: 'مسیر نامعتبر' }));

  ipcMain.handle('media:frame', async (_e, file, time, width) => {
    if (!isStr(file)) return null;
    try {
      return await runner.frame(file, Number(time) || 0, Math.min(1280, Math.max(64, Number(width) || 640)));
    } catch {
      return null;
    }
  });

  ipcMain.handle('plan:preview', (_e, kind, file, opts) => (isStr(file) ? service.preview(kind, file, opts) : { error: 'درخواست نامعتبر' }));

  ipcMain.handle('jobs:add', (_e, specs) => {
    if (!Array.isArray(specs)) return [];
    const clean = specs
      .filter((s) => s && ['video', 'audio', 'edit', 'record'].includes(s.kind) && isStr(s.input) && fs.existsSync(s.input))
      .filter((s) => s.kind !== 'record' || rec.isRecordedFile(s.input)) // only our own temp captures
      .map((s) => ({
        kind: s.kind,
        input: s.input,
        opts: s.opts || {},
        outputDir: isStr(s.outputDir) ? s.outputDir : null,
        outputPath: isStr(s.outputPath) && path.isAbsolute(s.outputPath) ? s.outputPath : null,
        name: isStr(s.name) ? String(s.name).slice(0, 200) : undefined,
        tempInput: s.kind === 'record',
        label: String(s.label || '').slice(0, 40),
      }));
    return queue.add(clean);
  });
  ipcMain.handle('jobs:list', () => queue.list());
  ipcMain.handle('jobs:cancel', (_e, id) => queue.cancel(id));
  ipcMain.handle('jobs:cancelAll', () => queue.cancelAll());
  ipcMain.handle('jobs:clear', () => queue.clearFinished());
  ipcMain.handle('jobs:retry', (_e, id) => queue.retry(id));

  ipcMain.handle('shell:open', (_e, file) => (producedFiles.has(file) ? shell.openPath(file) : 'denied'));
  ipcMain.handle('shell:reveal', (_e, file) => {
    if (producedFiles.has(file)) shell.showItemInFolder(file);
  });
  ipcMain.handle('shell:openFolder', (_e, dir) => (isStr(dir) && fs.existsSync(dir) ? shell.openPath(dir) : 'denied'));
}

/* --------------------------------------------------------------- lifecycle */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
  });
  app.on('before-quit', () => queue.cancelAll());
  app.on('window-all-closed', () => app.quit());
}

module.exports = { queue, runner };
