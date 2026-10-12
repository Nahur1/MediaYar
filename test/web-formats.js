'use strict';
/** Web build: every offered video/audio output format through ffmpeg.wasm + offline (service worker) check. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const PORT = 8125;
const log = (...a) => console.log(...a);
(async () => {
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'my-webf-'));
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve-web.js'), path.join(ROOT, 'dist', 'web'), String(PORT), '--no-isolation'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch({ executablePath: '/usr/local/bin/chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const saved = [];
  page.on('download', async (d) => { const p = path.join(dl, d.suggestedFilename()); await d.saveAs(p); saved.push(p); });
  let fail = 0;
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector('body[data-ready="1"]');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#video-drop')]);
    await fc.setFiles([path.join(FIX, 'multi.mkv')]);
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('.nav-item[data-page="audio"]').then(() => page.click('#audio-drop'))]);
    await fc2.setFiles([path.join(FIX, 'stereo.wav')]);
    const res = await page.evaluate(async () => {
      const ids = ['f1/multi.mkv', 'f2/stereo.wav'];
      for (const id of ids) await window.api.probe(id);
      const specs = [
        ...Object.keys(APP.catalog.videoFormats).map((format) => ({ kind: 'video', input: ids[0], opts: { format, quality: 'medium', resolution: 360, speed: 'fast', smartCopy: false }, label: format })),
        ...Object.keys(APP.catalog.audioFormats).map((format) => ({ kind: 'audio', input: ids[1], opts: { format }, label: format })),
      ];
      const added = await window.api.addJobs(specs);
      const want = new Set(added.map((j) => j.id));
      return new Promise((resolve) => {
        const fin = new Map();
        window.api.onJobUpdate((j) => {
          if (want.has(j.id) && ['done', 'error', 'canceled'].includes(j.status)) fin.set(j.id, j);
          if (fin.size === want.size) resolve([...fin.values()].map((x) => ({ label: x.label, status: x.status, out: x.outputName, size: x.outputSize, err: x.error, det: (x.errorDetails || '').slice(-300) })));
        });
      });
    });
    await page.waitForTimeout(1500);
    for (const r of res) {
      let ok = r.status === 'done';
      let info = '';
      if (ok) {
        const f = saved.find((p) => path.basename(p) === r.out);
        try {
          const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).toString());
          info = pr.streams.map((s) => s.codec_name).join('+') + ` ${Number(pr.format.duration).toFixed(1)}s`;
          ok = Number(pr.format.duration) > 4;
        } catch (e) { ok = false; info = `ffprobe failed ${e.message.slice(0, 80)}`; }
      }
      if (!ok) fail++;
      log(ok ? 'ok  ' : 'FAIL', r.label.padEnd(6), r.out || '', info, r.err || '', ok ? '' : r.det);
    }
    // offline: service worker serves the shell + cached engine
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(1500);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
    const [fc3] = await Promise.all([page.waitForEvent('filechooser'), page.click('#video-drop')]);
    await fc3.setFiles([path.join(FIX, 'sample.mp4')]);
    await page.waitForFunction(() => document.querySelector('#video-files .file:not(.loading)'), null, { timeout: 60000 });
    const offlineOk = await page.evaluate(() => !document.querySelector('#video-files .file.error'));
    log(offlineOk ? 'ok   offline: app + engine load from cache and probe works' : 'FAIL offline');
    if (!offlineOk) fail++;
  } catch (e) { console.error(e); fail++; }
  await browser.close(); srv.kill();
  log(fail ? `${fail} FAILED` : 'ALL WEB FORMATS PASSED');
  process.exit(fail ? 1 : 0);
})();
