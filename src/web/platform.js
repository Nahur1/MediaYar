'use strict';
/**
 * Web implementation of `window.api` — the exact interface the Electron preload exposes,
 * so the shared renderer (src/renderer) runs unchanged in the browser, as a PWA, or in an
 * Android WebView (Capacitor/TWA).
 */
const F = require('../core/formats');
const { createService } = require('../core/service');
const { Engine, Assets } = require('./engine');
const { WasmHost } = require('./wasm-host');

// Encoders present *and stable* in the bundled ffmpeg.wasm core: libvpx-vp9 and stereo libopus trap
// in wasm, so WEBM uses VP8 and Opus uses FFmpeg's native encoder; AMR has no encoder in this build.
const WEB_ENCODERS = ['libx264', 'libx265', 'libvpx', 'mpeg4', 'wmv2', 'mpeg2video', 'libtheora', 'gif',
  'aac', 'libmp3lame', 'opus', 'libvorbis', 'wmav2', 'mp2', 'ac3', 'flac', 'alac', 'pcm_s16le', 'pcm_s16be'];
F.restrict(WEB_ENCODERS, { opus: { encoder: 'opus', extra: ['-strict', '-2'] } });

const THEME_KEY = 'mediayar.theme';
const files = new Map(); // id -> File
const fileUrls = new Map(); // id -> object URL
const outputs = new Map(); // job.output token -> { blob, name, url? }
const dirs = new Map(); // token -> FileSystemDirectoryHandle
const targets = new Map(); // outputPath token -> { name, handle? } chosen in a save dialog
const recordings = new Set(); // file ids that are our own screen captures
const sinks = new Map(); // recording id -> { parts: Blob[], ext }
let seq = 0;

const engine = new Engine('jobs');
const probeEngine = new Engine('aux');

const canShare = (() => {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.mp4', { type: 'video/mp4' })] }));
  } catch { return false; }
})();
const canPickDir = typeof window.showDirectoryPicker === 'function';
const canSaveAs = typeof window.showSaveFilePicker === 'function';
const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && typeof window.MediaRecorder === 'function';
const SAVE_TYPES = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', gif: 'image/gif', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };

function register(file) {
  for (const [id, f] of files) {
    if (f === file || (f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) return id;
  }
  const id = `f${++seq}/${file.name}`;
  files.set(id, file);
  return id;
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function writeToDir(dir, out) {
  let name = out.name;
  const dot = name.lastIndexOf('.');
  for (let i = 2; ; i++) {
    try {
      await dir.getFileHandle(name);
      name = `${out.name.slice(0, dot)} (${i})${out.name.slice(dot)}`;
    } catch { break; } // NotFoundError -> free name
  }
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(out.blob);
  await w.close();
  out.savedAs = name;
}

/** Hand a finished output to the user: chosen folder (File System Access) or a normal download. */
async function deliver(job, out) {
  const t = job.outputPath && targets.get(job.outputPath);
  const dir = job.outputDir && dirs.get(job.outputDir);
  try {
    if (t && t.handle) {
      const w = await t.handle.createWritable();
      await w.write(out.blob);
      await w.close();
      out.savedAs = t.handle.name;
      return;
    }
    if (dir) return await writeToDir(dir, out);
  } catch (e) {
    console.warn('folder write failed, falling back to download', e);
  }
  triggerDownload(out.blob, out.name);
}

const host = new WasmHost({ files, engine, probeEngine, outputs, deliver, targets });
host.releaseInput = (id) => {
  if (!recordings.has(id)) return;
  recordings.delete(id);
  files.delete(id);
  const u = fileUrls.get(id);
  if (u) URL.revokeObjectURL(u);
  fileUrls.delete(id);
};
const service = createService(host);
const { queue } = service;
queue.on('removed', (j) => {
  const o = j.output && outputs.get(j.output);
  if (o && o.url) URL.revokeObjectURL(o.url);
  if (j.output) outputs.delete(j.output);
});

function pickFiles(kind, multi) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!multi;
    const exts = kind === 'audio' ? [...F.AUDIO_INPUT_EXT, ...F.VIDEO_INPUT_EXT] : F.VIDEO_INPUT_EXT;
    input.accept = [kind === 'audio' ? 'audio/*' : null, 'video/*', ...exts.map((e) => `.${e}`)].filter(Boolean).join(',');
    input.style.display = 'none';
    let settled = false;
    const done = (list) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(list);
    };
    input.addEventListener('change', () => done([...(input.files || [])].map(register)));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

/** Single frame as a data URL (for formats the browser can't play natively). */
function frame(id, time, width) {
  const f = files.get(id);
  if (!f) return Promise.resolve(null);
  const w = Math.min(1280, Math.max(64, Number(width) || 640));
  return probeEngine.task(async () => {
    const p = await probeEngine.mount(id, f);
    const out = `/o/frame-${Date.now().toString(36)}.jpg`;
    try {
      await probeEngine.exec(['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-ss', String(Math.max(0, Number(time) || 0)), '-i', p,
        '-frames:v', '1', '-vf', `scale=${w}:-2`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', out]);
      const data = await probeEngine.readFile(out);
      return await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.readAsDataURL(new Blob([data], { type: 'image/jpeg' }));
      });
    } catch {
      return null;
    } finally {
      await probeEngine.remove(out);
    }
  });
}

function outputOf(token) {
  const o = outputs.get(token);
  if (o && !o.url) o.url = URL.createObjectURL(o.blob);
  return o;
}

const listeners = { update: new Set(), idle: new Set() };
queue.on('update', (j) => listeners.update.forEach((fn) => fn(j)));
queue.on('idle', () => listeners.idle.forEach((fn) => fn(null)));
const subscribe = (set) => (cb) => { set.add(cb); return () => set.delete(cb); };

window.addEventListener('beforeunload', (e) => {
  if (queue.busy()) { e.preventDefault(); e.returnValue = ''; }
});

// Warm up the engine while the user is still picking files.
const warm = () => probeEngine.task(() => probeEngine.ensure()).catch(() => {});
if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 2500 }); else setTimeout(warm, 1200);

const api = {
  init: async () => ({
    catalog: F.catalog(),
    theme: localStorage.getItem(THEME_KEY) === 'dark' || (!localStorage.getItem(THEME_KEY) && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light',
    version: '1.2.0',
    platform: 'web',
    caps: {
      outputDir: canPickDir, reveal: false, download: true, share: canShare, defaultOut: 'پوشه‌ی دانلودها',
      saveDialog: canSaveAs, screenRecord: canRecord, regionOverlay: false, hideApp: false, systemAudio: canRecord,
    },
  }),
  setTheme: async (t) => {
    const theme = t === 'dark' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#15111E' : '#FBF9FF';
    return theme;
  },
  openFiles: (kind, multi = true) => pickFiles(kind, multi),
  openFolder: async () => {
    if (!canPickDir) return null;
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'mediayar-out' });
      const token = `📁 ${handle.name}`;
      dirs.set(token, handle);
      return token;
    } catch { return null; }
  },
  probe: (id) => service.probe(id),
  frame,
  preview: (kind, id, opts) => service.preview(kind, id, opts),
  addJobs: async (specs) => {
    if (!Array.isArray(specs)) return [];
    const clean = specs
      .filter((s) => s && ['video', 'audio', 'edit', 'record'].includes(s.kind) && files.has(s.input))
      .filter((s) => s.kind !== 'record' || recordings.has(s.input))
      .map((s) => ({
        kind: s.kind,
        input: s.input,
        opts: s.opts || {},
        outputDir: dirs.has(s.outputDir) ? s.outputDir : null,
        outputPath: targets.has(s.outputPath) ? s.outputPath : null,
        name: typeof s.name === 'string' && s.name ? s.name.slice(0, 200) : undefined,
        tempInput: s.kind === 'record',
        label: String(s.label || '').slice(0, 40),
      }));
    return queue.add(clean);
  },
  /** Native "Save as" (File System Access). Returns an opaque token, or null if canceled. */
  saveFile: async (o = {}) => {
    const ext = String(o.ext || '').toLowerCase();
    const name = String(o.name || 'output').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').trim() || 'output';
    const full = ext && !name.toLowerCase().endsWith(`.${ext}`) ? `${name}.${ext}` : name;
    if (!canSaveAs) return api.downloadTarget(full);
    try {
      const types = ext ? [{ description: ext.toUpperCase(), accept: { [SAVE_TYPES[ext] || 'application/octet-stream']: [`.${ext}`] } }] : undefined;
      const handle = await window.showSaveFilePicker({ suggestedName: full, types, id: `mediayar-${o.key || 'out'}`.slice(0, 32), startIn: o.key === 'record' ? 'videos' : 'downloads' });
      const token = `💾 ${handle.name}#${++seq}`;
      targets.set(token, { name: handle.name, handle });
      return token;
    } catch {
      return null; // AbortError = user canceled
    }
  },
  /** Browser download with a chosen file name (where no save dialog exists). */
  downloadTarget: (name) => {
    const token = `⬇ ${name}#${++seq}`;
    targets.set(token, { name });
    return token;
  },
  // screen-recording sink: chunks stay as Blobs (no copies) and become one File at the end
  recOpen: async (ext) => {
    const id = `rec${++seq}`;
    sinks.set(id, { parts: [], ext: ext === 'mp4' ? 'mp4' : 'webm' });
    return id;
  },
  recWrite: async (id, data) => {
    const s = sinks.get(id);
    if (!s) return false;
    s.parts.push(data instanceof Blob ? data : new Blob([data]));
    return true;
  },
  recClose: async (id) => {
    const s = sinks.get(id);
    if (!s) return null;
    sinks.delete(id);
    const file = new File(s.parts, `recording-${Date.now()}.${s.ext}`, { type: s.ext === 'mp4' ? 'video/mp4' : 'video/webm' });
    const fid = register(file);
    recordings.add(fid);
    return { path: fid, size: file.size };
  },
  recDiscard: async (id) => {
    sinks.delete(id);
    if (recordings.has(id)) host.releaseInput(id);
    return true;
  },
  listJobs: async () => queue.list(),
  cancelJob: async (id) => queue.cancel(id),
  cancelAll: async () => queue.cancelAll(),
  clearJobs: async () => queue.clearFinished(),
  retryJob: async (id) => queue.retry(id),
  openPath: async (token) => {
    const o = outputOf(token);
    if (o) window.open(o.url, '_blank', 'noopener');
  },
  reveal: async () => {},
  openFolder2: async () => {},
  download: async (token) => {
    const o = outputs.get(token);
    if (o) triggerDownload(o.blob, o.name);
  },
  share: async (token) => {
    const o = outputs.get(token);
    if (!o || !canShare) return false;
    try {
      await navigator.share({ files: [new File([o.blob], o.name, { type: o.blob.type })], title: o.name });
      return true;
    } catch { return false; }
  },
  onJobUpdate: subscribe(listeners.update),
  onIdle: subscribe(listeners.idle),
  onEngineProgress: (cb) => Assets.onProgress(cb),
  pathForFile: (file) => (file instanceof File ? register(file) : ''),
  fileUrl: (id) => {
    if (!fileUrls.has(id) && files.has(id)) fileUrls.set(id, URL.createObjectURL(files.get(id)));
    return fileUrls.get(id) || '';
  },
};

window.api = api;

/* ------------------------------------------------------------------ PWA */
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.Capacitor) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  document.dispatchEvent(new CustomEvent('mediayar:installable'));
});
window.api.canInstall = () => !!installPrompt;
window.api.install = async () => {
  if (!installPrompt) return false;
  installPrompt.prompt();
  const r = await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  return !!r && r.outcome === 'accepted';
};
