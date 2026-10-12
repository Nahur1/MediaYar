'use strict';
/** Thin, robust wrapper around the ffmpeg / ffprobe executables. */
const { spawn } = require('child_process');
const { FFmpegError, AbortError, explain } = require('./errors');
const { createProgressParser } = require('./progress');

const STDERR_KEEP = 40; // lines kept for error reports

function spawnOpts(cwd) {
  return { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
}

class Runner {
  /** @param {{ffmpeg:string, ffprobe:string}} bins */
  constructor(bins) {
    this.ffmpeg = bins.ffmpeg;
    this.ffprobe = bins.ffprobe;
  }

  /** Run ffprobe and return parsed JSON. */
  probe(file, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
      const p = spawn(this.ffprobe, args, spawnOpts());
      const out = [];
      let err = '';
      const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.stdout.on('data', (d) => out.push(d));
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { clearTimeout(timer); reject(new FFmpegError('ffprobe اجرا نشد', e.message)); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new FFmpegError('فایل قابل خواندن نیست یا فرمت آن پشتیبانی نمی‌شود.', err.trim()));
        try {
          const json = JSON.parse(Buffer.concat(out).toString('utf8'));
          if (!json.streams || !json.streams.length) throw new Error('no streams');
          resolve(json);
        } catch (e) {
          reject(new FFmpegError('فایل قابل خواندن نیست یا فرمت آن پشتیبانی نمی‌شود.', err.trim() || e.message));
        }
      });
    });
  }

  /**
   * Run ffmpeg with `-progress pipe:1` style arguments.
   * @param {string[]} args
   * @param {{cwd?:string, duration?:number, signal?:AbortSignal,
   *          onProgress?:(p:{ratio:number, time:number, speed:number})=>void}} o
   */
  run(args, o = {}) {
    return new Promise((resolve, reject) => {
      if (o.signal && o.signal.aborted) return reject(new AbortError());
      const p = spawn(this.ffmpeg, args, spawnOpts(o.cwd));
      const errLines = [];
      const parser = createProgressParser({ duration: o.duration, onProgress: o.onProgress });
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Partial output is discarded anyway, so terminate immediately
        // (graceful SIGTERM can take long while encoders drain their queues).
        p.kill('SIGKILL');
      };
      if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });

      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (chunk) => parser.push(chunk));
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', (chunk) => {
        for (const l of chunk.split(/\r?\n/)) {
          if (!l.trim()) continue;
          errLines.push(l);
          if (errLines.length > STDERR_KEEP) errLines.shift();
        }
      });
      p.on('error', (e) => reject(new FFmpegError('ffmpeg اجرا نشد', e.message)));
      p.on('close', (code) => {
        if (o.signal) o.signal.removeEventListener('abort', onAbort);
        if (aborted) return reject(new AbortError());
        if (code === 0) return resolve({ log: errLines.join('\n') });
        reject(new FFmpegError(explain(errLines), errLines.join('\n')));
      });
    });
  }

  /** Grab a single JPEG frame (for previews of formats the browser can't play). */
  frame(file, time, width = 640) {
    return new Promise((resolve, reject) => {
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(Math.max(0, time)), '-i', file,
        '-frames:v', '1', '-vf', `scale=${width}:-2`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'];
      const p = spawn(this.ffmpeg, args, spawnOpts());
      const out = [];
      const timer = setTimeout(() => p.kill('SIGKILL'), 15000);
      p.stdout.on('data', (d) => out.push(d));
      p.stderr.resume();
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', () => {
        clearTimeout(timer);
        const b = Buffer.concat(out);
        if (!b.length) return reject(new Error('no frame'));
        resolve(`data:image/jpeg;base64,${b.toString('base64')}`);
      });
    });
  }
}

module.exports = { Runner, FFmpegError, AbortError, explain };
