'use strict';
/**
 * End-to-end test of the built web app (dist/web) in headless Chromium:
 * real ffmpeg.wasm conversions driven through the shared UI, outputs verified with ffprobe.
 *   node scripts/build-web.js && node test/web-e2e.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const SHOTS = path.join(__dirname, 'shots-web');
const PORT = 8123;
const fx = (n) => path.join(FIX, n);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).toString());
const assert = (c, m) => { if (!c) throw new Error(`ASSERT: ${m}`); log('ok -', m); };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'my-web-'));
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve-web.js'), path.join(ROOT, 'dist', 'web'), String(PORT), '--no-isolation'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 840 } });
  const page = await ctx.newPage();
  // main page: browser without a save picker -> name dialog + regular downloads
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const downloads = [];
  page.on('download', async (d) => {
    const p = path.join(dl, d.suggestedFilename());
    await d.saveAs(p);
    downloads.push(p);
    log('downloaded', d.suggestedFilename());
  });
  const shot = async (name, p = page) => { await p.waitForTimeout(300); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const pick = async (sel, files) => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
    await fc.setFiles(files);
  };
  const waitDone = async (n, timeout = 300000) => {
    await page.waitForFunction((n) => document.querySelectorAll('.job.done, .job.error, .job.canceled').length >= n, n, { timeout });
  };
  const confirmSave = async () => { await page.waitForSelector('.modal'); await page.click('.modal .btn.primary'); };
  const jobErrors = () => page.$$eval('.job.error', (els) => els.map((e) => e.innerText));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
    const cat = await page.evaluate(() => ({ a: Object.keys(APP.catalog.audioFormats), e: APP.catalog.editorFormats.webm, v: APP.catalog.videoFormats.webm }));
    assert(!cat.a.includes('amr') && cat.a.length === 11, 'web catalog hides AMR (no encoder in wasm)');
    assert(cat.e.codecs.join() === 'vp8' && cat.v.codecs.join() === 'vp8', 'WEBM uses VP8 in the browser');
    await page.click('[data-theme-btn="light"]');
    await shot('01-video-empty-light');

    // ---- video: remux MKV->MP4 (copy) + AVI (no audio, odd dims) -> MP4 480p
    await pick('#video-drop', [fx('multi.mkv'), fx('odd_noaudio.avi')]);
    await page.waitForFunction(() => document.querySelectorAll('#video-files .file:not(.loading)').length === 2, null, { timeout: 120000 });
    log('probed 2 videos');
    await page.click('#video-format [data-value="mp4"]');
    await page.selectOption('#video-res', '480');
    await shot('02-video-files-light');
    await page.click('#video-start');
    await confirmSave();
    await page.waitForSelector('#page-queue.active');
    await waitDone(2);
    assert((await jobErrors()).length === 0, `video jobs ok ${await jobErrors()}`);
    await shot('03-queue-light');

    // ---- audio: wav -> mp3, flac 5.1 -> ogg
    await page.click('.nav-item[data-page="audio"]');
    await pick('#audio-drop', [fx('stereo.wav'), fx('surround51.flac')]);
    await page.waitForFunction(() => document.querySelectorAll('#audio-files .file:not(.loading)').length === 2, null, { timeout: 60000 });
    await page.click('#audio-format [data-value="ogg"]');
    await page.click('#audio-start');
    await confirmSave();
    await waitDone(4);
    await page.click('.nav-item[data-page="audio"]');
    await pick('#audio-drop', [fx('stereo.wav'), fx('surround51.flac')]);
    await page.waitForFunction(() => document.querySelectorAll('#audio-files .file:not(.loading)').length === 2, null, { timeout: 60000 });
    await page.click('#audio-format [data-value="mp3"]');
    await page.click('#audio-start');
    await confirmSave();
    await waitDone(6);
    assert((await jobErrors()).length === 0, 'audio jobs ok');

    // ---- editor: trim 3.0-15.5 of big.mp4 (1080p) -> 1/2 size, crop 1:1
    await page.click('.nav-item[data-page="editor"]');
    await pick('#editor-drop', [fx('sample.mp4')]);
    await page.waitForSelector('#editor:not([hidden])', { timeout: 60000 });
    await page.waitForTimeout(2500);
    const painted = await page.evaluate(() => [...document.querySelectorAll('#tl-strip canvas')].filter((c) => {
      const d = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data; return d[0] + d[1] + d[2] > 0;
    }).length);
    assert(painted >= 10, `filmstrip painted by the browser decoder (${painted}/12)`);
    await page.fill('#ed-start', '00:00:01.000');
    await page.press('#ed-start', 'Enter');
    await page.fill('#ed-end', '00:00:06.000');
    await page.press('#ed-end', 'Enter');
    await page.click('#ed-compress [data-value="r2"]');
    await page.click('#ed-crop [data-value="1:1"]');
    await page.waitForFunction(() => document.querySelector('#ed-summary').textContent.includes('کمتر'));
    await shot('04-editor-light');
    await page.click('#ed-save');
    await confirmSave();
    await waitDone(7);
    assert((await jobErrors()).length === 0, `editor job ok ${await jobErrors()}`);

    // ---- webm (vp8) from editor with remove-middle
    await page.click('.nav-item[data-page="editor"]');
    await page.click('#ed-cutmode [data-value="remove"]');
    await page.click('#ed-compress [data-value="none"]');
    await page.click('#ed-crop [data-value="none"]');
    await page.click('#ed-format [data-value="webm"]');
    await page.selectOption('#ed-res', '360');
    await page.waitForTimeout(400);
    await page.click('#ed-save');
    await confirmSave();
    await waitDone(8);
    assert((await jobErrors()).length === 0, `editor webm job ok ${await jobErrors()}`);

    // ---- cancel
    await page.click('.nav-item[data-page="video"]');
    await pick('#video-drop', [fx('sample.mp4')]);
    await page.waitForFunction(() => document.querySelectorAll('#video-files .file:not(.loading)').length === 1, null, { timeout: 60000 });
    await page.click('#video-format [data-value="mkv"]');
    await page.click('#video-start');
    await confirmSave();
    await page.waitForFunction(() => document.querySelector('.job.running'), null, { timeout: 20000 });
    await page.waitForTimeout(2500);
    await page.click('.job.running .btn.danger');
    await page.waitForFunction(() => document.querySelector('.job').classList.contains('canceled'), null, { timeout: 15000 });
    log('canceled');
    // engine must recover after a hard cancel
    await page.click('.nav-item[data-page="audio"]');
    await pick('#audio-drop', [fx('stereo.wav')]);
    await page.waitForFunction(() => document.querySelectorAll('#audio-files .file:not(.loading)').length === 1, null, { timeout: 60000 });
    await page.click('#audio-format [data-value="flac"]');
    await page.click('#audio-start');
    await confirmSave();
    await waitDone(10);
    assert((await jobErrors()).length === 0, 'engine recovers after cancel');
    await page.click('[data-theme-btn="dark"]');
    await page.click('.nav-item[data-page="queue"]');
    await shot('05-queue-dark');
    await page.click('.nav-item[data-page="editor"]');
    await shot('06-editor-dark');

    // ---- screen recording (fake capture device + fake microphone, File System Access picker)
    const r = await ctx.newPage();
    await r.addInitScript(() => {
      window.__saved = {};
      window.showSaveFilePicker = async ({ suggestedName }) => ({
        name: suggestedName,
        createWritable: async () => {
          const parts = [];
          return { write: async (b) => { parts.push(b); }, close: async () => { window.__saved[suggestedName] = new Blob(parts); } };
        },
      });
    });
    r.on('pageerror', (e) => errors.push(e.message));
    await r.goto(`http://127.0.0.1:${PORT}/`);
    await r.waitForSelector('body[data-ready="1"]');
    await r.click('[data-theme-btn="light"]');
    await r.click('.nav-item[data-page="record"]');
    await r.click('#rec-audio [data-value="mic"]');
    await r.click('label:has(#rec-countdown)');
    await shot('08b-record-light', r);
    const mime = await r.evaluate(() => ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'].filter((m) => MediaRecorder.isTypeSupported(m)));
    log('MediaRecorder types', mime.join(' | '));
    const saved = async (re) => {
      await r.waitForFunction((src) => Object.keys(window.__saved).some((k) => new RegExp(src).test(k)), re.source, { timeout: 180000 });
      const [name, b64] = await r.evaluate(async (src) => {
        const k = Object.keys(window.__saved).find((x) => new RegExp(src).test(x));
        const buf = new Uint8Array(await window.__saved[k].arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        delete window.__saved[k];
        return [k, btoa(bin)];
      }, re.source);
      const f = path.join(dl, name);
      fs.writeFileSync(f, Buffer.from(b64, 'base64'));
      return f;
    };
    await r.click('#rec-start');
    await r.waitForFunction(() => document.body.dataset.rec === 'recording', null, { timeout: 20000 });
    await r.waitForTimeout(3000);
    await shot('08c-recording-light', r);
    await r.click('#rec-stop');
    const rec1 = await saved(/^ضبط صفحه .*\.(mp4|webm)$/);
    const p1 = probe(rec1);
    const v1 = p1.streams.find((x) => x.codec_type === 'video');
    const a1 = p1.streams.find((x) => x.codec_type === 'audio');
    log('web recording', path.basename(rec1), v1.codec_name, `${v1.width}x${v1.height}`, a1 && a1.codec_name, p1.format.duration);
    assert(Number(p1.format.duration) > 2 && Number(p1.format.duration) < 5, 'web recording has a real duration (seekable)');
    assert(a1, 'microphone audio recorded');
    // region picked on the live preview
    await r.click('.nav-item[data-page="record"]');
    await r.click('#rec-mode [data-value="region"]');
    await r.click('#rec-start');
    await r.waitForSelector('.modal .pick-stage', { timeout: 20000 });
    await r.waitForTimeout(500);
    const box = await (await r.$('.modal .pick-stage')).boundingBox();
    await r.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await r.mouse.down();
    await r.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 });
    await r.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.75, { steps: 5 });
    await r.mouse.up();
    await shot('08d-region-pick-light', r);
    await r.click('#rec-pick-ok');
    await r.waitForFunction(() => document.body.dataset.rec === 'recording', null, { timeout: 20000 });
    const full = await r.evaluate(() => document.querySelector('#rec-preview').srcObject.getVideoTracks()[0].getSettings());
    await r.waitForTimeout(2500);
    await r.click('#rec-stop');
    const rec2 = await saved(/^ضبط صفحه .*\.mp4$/);
    const v2 = probe(rec2).streams.find((x) => x.codec_type === 'video');
    log('web region recording', `${v2.width}x${v2.height} of ${full.width}x${full.height}`);
    assert(Math.abs(v2.width - full.width / 2) <= 4 && Math.abs(v2.height - full.height / 2) <= 4 && v2.codec_name === 'h264', 'region crop is half of the frame (h264 mp4)');
    await r.close();

    // ---- mobile layout
    const m = await ctx.newPage();
    await m.setViewportSize({ width: 390, height: 844 });
    await m.goto(`http://127.0.0.1:${PORT}/`);
    await m.waitForSelector('body[data-ready="1"]');
    await shot('07-mobile-video-dark', m);
    await m.click('[data-theme-btn="light"]');
    await m.click('.nav-item[data-page="editor"]');
    await shot('08-mobile-editor-light', m);
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(overflow <= 1, `no horizontal overflow on phones (${overflow}px)`);
    await m.close();

    // ---- verify outputs
    await page.waitForTimeout(1000);
    const byName = (re) => downloads.filter((p) => re.test(path.basename(p)));
    const mp4s = byName(/^(multi|odd_noaudio)\.mp4$/);
    assert(mp4s.length === 2, 'two MP4 conversions downloaded');
    const mk = probe(byName(/^multi\.mp4$/)[0]);
    assert(mk.streams.filter((s) => s.codec_type === 'audio').length >= 2, 'multi-audio preserved');
    const av = probe(byName(/^odd_noaudio\.mp4$/)[0]).streams.find((s) => s.codec_type === 'video');
    assert(['h264', 'mpeg4'].includes(av.codec_name) && Math.min(av.width, av.height) <= 480 && av.width % 2 === 0, `AVI -> MP4 (${av.codec_name}, smart copy when possible) ${av.width}x${av.height}`);
    for (const re of [/^stereo\.ogg$/, /^surround51\.ogg$/, /^stereo\.mp3$/, /^surround51\.mp3$/]) {
      const f = byName(re)[0];
      assert(f && Number(probe(f).format.duration) > 1, `audio ${re} ok`);
    }
    const ed = byName(/^sample_edited\.mp4$/)[0];
    const ep = probe(ed);
    const ev = ep.streams.find((s) => s.codec_type === 'video');
    const srcBytes = fs.statSync(fx('sample.mp4')).size;
    const srcDur = Number(probe(fx('sample.mp4')).format.duration);
    const target = (srcBytes * (5 / srcDur)) / 2;
    const size = fs.statSync(ed).size;
    assert(Math.abs(Number(ep.format.duration) - 5) < 0.15, `edited duration ${ep.format.duration}`);
    assert(ev.width === ev.height, `square crop ${ev.width}x${ev.height}`);
    assert(Math.abs(size - target) / target < 0.15, `1/2 size target: ${size} vs ${Math.round(target)}`);
    const wb = byName(/^sample_edited\.webm$/)[0];
    const wp = probe(wb);
    assert(wp.streams.find((s) => s.codec_type === 'video').codec_name === 'vp8', 'webm is vp8');
    assert(Math.abs(Number(wp.format.duration) - (srcDur - 5)) < 0.3, `remove-middle duration ${wp.format.duration}`);
    const real = errors.filter((e) => !/favicon|ErrorEvent|^null$/i.test(e));
    assert(real.length === 0, `no page errors ${real.join(' | ')}`);
    log('WEB E2E PASSED');
  } catch (e) {
    console.error('FAILED', e);
    await shot('99-failure').catch(() => {});
    console.error('page errors:', errors.slice(-10));
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.kill();
    process.exit(process.exitCode || 0);
  }
})();
