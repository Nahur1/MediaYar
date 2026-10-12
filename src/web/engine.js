'use strict';
/**
 * FFmpeg-in-the-browser engine (ffmpeg.wasm), with:
 *  - one-time core download with progress, shared by every engine instance (blob URLs),
 *  - serialized task queue per instance,
 *  - zero-copy inputs (WORKERFS mounts read straight from the user's File),
 *  - hard cancel (worker terminate) with transparent reload on next use.
 */
const { FFmpegError, AbortError, explain } = require('../core/errors');
const { createProgressParser } = require('../core/progress');

const BASE = new URL('./', document.currentScript ? document.currentScript.src : location.href);
const VENDOR = new URL('../vendor/', BASE).href;

/** Downloads the ~30 MB core once and hands out blob URLs (cache-first via the service worker). */
const Assets = {
  urls: null,
  loading: null,
  listeners: new Set(),
  onProgress(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit(p) { for (const fn of this.listeners) fn(p); },
  async fetchBlob(url, type, track) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!track || !res.body || !total) return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      this.emit({ loaded: got, total, ratio: got / total });
    }
    return URL.createObjectURL(new Blob(chunks, { type }));
  },
  get() {
    if (this.urls) return Promise.resolve(this.urls);
    if (!this.loading) {
      this.loading = (async () => {
        const core = `${VENDOR}core/`;
        const [coreURL, wasmURL] = await Promise.all([
          this.fetchBlob(`${core}ffmpeg-core.js`, 'text/javascript'),
          this.fetchBlob(`${core}ffmpeg-core.wasm`, 'application/wasm', true),
        ]);
        this.urls = { coreURL, wasmURL };
        this.emit({ ratio: 1, done: true });
        return this.urls;
      })().catch((e) => {
        this.loading = null;
        this.emit({ error: true });
        throw e;
      });
    }
    return this.loading;
  },
};

let FFmpegClass = null;
async function loadClass() {
  if (!FFmpegClass) FFmpegClass = (await import(/* webpackIgnore: true */ `${VENDOR}ffmpeg/index.js`)).FFmpeg;
  return FFmpegClass;
}

class Engine {
  constructor(name) {
    this.name = name;
    this.ff = null;
    this.loading = null;
    this.chain = Promise.resolve();
    this.mounted = new Map(); // id -> fs path
    this.logSink = null;
  }

  /** Run fn exclusively on this instance. */
  task(fn) {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  async ensure() {
    if (this.ff) return this.ff;
    if (!this.loading) {
      this.loading = (async () => {
        const [FFmpeg, urls] = await Promise.all([loadClass(), Assets.get()]);
        const ff = new FFmpeg();
        ff.on('log', (e) => this.logSink && this.logSink(e));
        await ff.load(urls);
        await ff.createDir('/m');
        await ff.createDir('/o');
        this.ff = ff;
        return ff;
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  /** Kill the worker (only way to stop a running command); reloads lazily. */
  reset() {
    if (this.ff) {
      try { this.ff.terminate(); } catch { /* already gone */ }
    }
    this.ff = null;
    this.mounted.clear();
  }

  /** Mount a File read-only (zero-copy) and return its path inside the engine. */
  async mount(id, file) {
    const ff = await this.ensure();
    if (this.mounted.has(id)) return this.mounted.get(id);
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const dir = `/m/${this.mounted.size + 1}${Date.now().toString(36)}`;
    await ff.createDir(dir);
    const named = new File([file], `input.${ext}`, { type: file.type }); // same bytes, safe name
    await ff.mount('WORKERFS', { files: [named] }, dir);
    const p = `${dir}/input.${ext}`;
    this.mounted.set(id, p);
    return p;
  }

  /**
   * Execute ffmpeg (or ffprobe) args. Resolves on exit code 0, rejects with FFmpegError / AbortError.
   * Must be called inside task().
   */
  async exec(args, { signal, duration, onProgress, probe = false } = {}) {
    if (signal && signal.aborted) throw new AbortError();
    const ff = await this.ensure();
    const errLines = [];
    const parser = createProgressParser({ duration, onProgress });
    this.logSink = (e) => {
      if (e.type === 'stdout') parser.line(e.message);
      else if (e.message && e.message.trim()) {
        errLines.push(e.message);
        if (errLines.length > 40) errLines.shift();
      }
    };
    let onAbort = null;
    try {
      const aborted = new Promise((_, reject) => {
        onAbort = () => { this.reset(); reject(new AbortError()); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });
      const run = probe ? ff.ffprobe(args) : ff.exec(args);
      const code = await Promise.race([run, aborted]);
      // ffprobe's return code is unreliable in ffmpeg.wasm; its output file is checked by the caller.
      if (code !== 0 && !probe) throw new FFmpegError(explain(errLines), errLines.join('\n'));
      return { log: errLines.join('\n') };
    } catch (e) {
      if (e instanceof AbortError || e instanceof FFmpegError) throw e;
      // A wasm trap leaves the instance in an undefined state: start fresh next time.
      this.reset();
      const details = `${errLines.join('\n')}\n${e && (e.stack || e.message || e)}`;
      throw new FFmpegError(explain(`${details}`), details);
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      this.logSink = null;
    }
  }

  async readFile(p) { return (await this.ensure()).readFile(p); }

  async remove(p) {
    if (!this.ff) return;
    try { await this.ff.deleteFile(p); } catch { /* not there */ }
  }

  /** Delete leftovers of 2-pass encodes in the working directory. */
  async sweep() {
    if (!this.ff) return;
    try {
      const list = await this.ff.listDir('/');
      await Promise.all(list.filter((n) => !n.isDir && /^(ffpass|x265pass)/.test(n.name)).map((n) => this.remove(`/${n.name}`)));
    } catch { /* ignore */ }
  }
}

module.exports = { Engine, Assets };
