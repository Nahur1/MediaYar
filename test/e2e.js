'use strict';
/**
 * Drives the real Electron app (Linux build of the same Electron version) headlessly:
 * native dialogs are stubbed, everything else (IPC, ffmpeg, queue, UI) is real.
 */
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const SHOTS = path.join(__dirname, 'shots');
const ELECTRON = process.env.ELECTRON_BIN || '/data/dl/elin/electron';
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mediayar-e2e-'));
const log = (...a) => console.log('•', ...a);
const assert = (c, m) => { if (!c) throw new Error(`ASSERT: ${m}`); };

(async () => {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: ['--no-sandbox', '--disable-gpu', ROOT],
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99', MEDIAYAR_FFMPEG_DIR: path.dirname(execSync('which ffmpeg').toString().trim()) },
  });
  const errors = [];
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', e.stack || e); });
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('CONSOLE', m.text()); } });
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
  await page.evaluate(() => localStorage.clear()); // fresh UI memory (save locations etc.)
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
  log('app ready');

  const stubDialog = (files, folder = OUT, cancelSaves = 0) => app.evaluate(({ dialog, shell }, [f, d, cancel]) => {
    globalThis.saveCalls = globalThis.saveCalls || [];
    let toCancel = cancel;
    dialog.showOpenDialog = async (w, o) => {
      const opts = o || w;
      return { canceled: false, filePaths: opts.properties.includes('openDirectory') ? [d] : f };
    };
    dialog.showSaveDialog = async (w, o) => {
      const opts = o || w;
      globalThis.saveCalls.push(opts.defaultPath);
      if (toCancel > 0) { toCancel--; return { canceled: true }; }
      return { canceled: false, filePath: `${d}/${String(opts.defaultPath).split(/[\\/]/).pop()}` };
    };
    shell.openPath = async () => '';
    shell.showItemInFolder = () => {};
  }, [files, folder, cancelSaves]);
  const saveCalls = () => app.evaluate(() => globalThis.saveCalls || []);
  const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); log('shot', name); };
  const waitJobs = async (n, timeout = 180000) => {
    await page.waitForFunction((count) => {
      const jobs = [...document.querySelectorAll('.job')];
      return jobs.length >= count && jobs.slice(0, count).every((j) => /done|error|canceled/.test(j.className));
    }, n, { timeout });
    return page.$$eval('.job', (els) => els.map((e) => e.className + ' | ' + e.querySelector('.job-result').textContent));
  };

  await page.click('[data-theme-btn="light"]');
  await shot('01-video-empty-light');

  // ---------------- video conversion
  await stubDialog([path.join(FIX, 'multi.mkv'), path.join(FIX, 'odd_noaudio.avi'), path.join(FIX, 'ویدیو تست با فاصله.mp4')]);
  await page.click('#video-drop');
  await page.waitForFunction(() => document.querySelectorAll('#video-files .file:not(.loading)').length === 3);
  await page.click('#video-format [data-value="mp4"]');
  await page.selectOption('#video-res', '480');
  await shot('02-video-files-light');
  assert((await page.textContent('#video-start')).includes('3'), 'start button shows count');
  await page.click('#video-start');
  await page.waitForSelector('.modal');
  await shot('02b-save-ask-batch-light');
  await page.click('.modal [data-save="choose"]');
  await page.waitForSelector('.modal .opt.custom.active');
  assert((await page.textContent('.modal .opt-path')) === OUT, 'custom folder shown');
  await shot('02c-save-ask-custom-light');
  await page.click('.modal [data-save="ok"]');
  await page.waitForSelector('#page-queue.active');
  let states = await waitJobs(3);
  log(states);
  assert(states.every((s) => s.includes('done')), 'video jobs done');
  await shot('03-queue-done-light');

  // ---------------- audio conversion
  await page.click('.nav-item[data-page="audio"]');
  await stubDialog([path.join(FIX, 'stereo.wav'), path.join(FIX, 'surround51.flac'), path.join(FIX, 'sample.mp4')]);
  await page.click('#audio-drop');
  await page.waitForFunction(() => document.querySelectorAll('#audio-files .file:not(.loading)').length === 3);
  await page.click('#audio-format [data-value="ogg"]');
  await shot('04-audio-light');
  await page.click('#audio-start');
  await page.waitForSelector('.modal');
  await page.click('.modal [data-save="choose"]');
  await page.click('.modal [data-save="ok"]');
  states = await waitJobs(3);
  assert(states.slice(0, 3).every((s) => s.includes('done')), 'audio jobs done');
  log('audio ok');

  // ---------------- editor
  await page.click('.nav-item[data-page="editor"]');
  await shot('05-editor-empty-light');
  await stubDialog([path.join(FIX, 'big.mp4')]);
  await page.click('#editor-drop');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('#tl-strip canvas[data-painted]').length >= 12, null, { timeout: 40000 });
  const playable = await page.waitForFunction(() => document.querySelector('#ed-video').readyState >= 2 || !document.querySelector('#ed-frame').hidden, null, { timeout: 15000 }).then(() => page.evaluate(() => document.querySelector('#ed-video').readyState));
  log('video readyState', playable);
  await page.evaluate(() => { document.querySelector('#ed-video').currentTime = 6; });
  await shot('05b-editor-loaded-light');
  await page.fill('#ed-start', '00:00:03.000');
  await page.press('#ed-start', 'Enter');
  await page.fill('#ed-end', '00:00:15.500');
  await page.press('#ed-end', 'Enter');
  await page.click('#ed-compress [data-value="r2"]');
  await page.click('#ed-crop [data-value="1:1"]');
  await page.waitForFunction(() => document.querySelector('#ed-summary').textContent.includes('کمتر'));
  const sum = await page.textContent('#ed-summary');
  log('summary:', sum.replace(/\s+/g, ' '));
  await shot('06-editor-light');
  await page.click('#ed-compress [data-value="size"]');
  await page.fill('#ed-size', '5000');
  await page.waitForFunction(() => document.querySelector('#ed-summary').classList.contains('error'));
  assert(await page.isDisabled('#ed-save'), 'cta disabled on error');
  await page.click('#ed-compress [data-value="r2"]');
  await page.waitForFunction(() => !document.querySelector('#ed-summary').classList.contains('error'));
  await page.click('#ed-save');
  states = await waitJobs(7, 240000);
  log(states[0]);
  assert(states[0].includes('done'), 'edit job done');
  const sc = await saveCalls();
  log('save dialog suggestion:', sc[sc.length - 1]);
  assert(sc[sc.length - 1] === path.join(FIX, 'big_edited.mp4'), 'editor suggests <name>_edited next to the source');
  assert(fs.existsSync(path.join(OUT, 'big_edited.mp4')), 'edited file saved where chosen');
  assert(!fs.readdirSync(OUT).some((f) => f.includes('mediayar-part')), 'no partial files');

  // ---------------- screen recording: full screen, stop from the floating bar
  const probe = (f) => JSON.parse(execSync(`ffprobe -v error -print_format json -show_format -show_streams "${f}"`).toString());
  const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('mediayar-rec-'));
  await page.click('.nav-item[data-page="record"]');
  await page.waitForFunction(() => document.querySelector('#rec-outdir .outdir-path').textContent.length > 0);
  await shot('06b-record-page-light');
  await page.click('#rec-hide-field');
  await stubDialog([], OUT, 1); // first save dialog is canceled -> "not saved yet" prompt
  await page.click('#rec-start');
  await page.waitForFunction(() => document.body.dataset.rec === 'countdown', null, { timeout: 15000 });
  await page.waitForFunction(() => document.body.dataset.rec === 'recording', null, { timeout: 15000 });
  const barWin = app.windows().find((w) => w.url().includes('control.html'));
  assert(barWin, 'floating control bar shown');
  await page.waitForTimeout(3200);
  await shot('06c-recording-light');
  await barWin.screenshot({ path: path.join(SHOTS, '06d-control-bar.png') });
  await barWin.click('#stop');
  await page.waitForSelector('.modal #rec-save-again', { timeout: 20000 });
  await shot('06e-record-not-saved');
  await page.click('#rec-save-again');
  await page.waitForSelector('#page-queue.active', { timeout: 20000 });
  states = await waitJobs(8, 120000);
  log(states[0]);
  assert(states[0].includes('done'), 'recording saved');
  const recFile = fs.readdirSync(OUT).find((f) => f.startsWith('ضبط صفحه') && f.endsWith('.mp4'));
  assert(recFile, 'recording file in chosen folder');
  let pr = probe(path.join(OUT, recFile));
  const rv = pr.streams.find((x) => x.codec_type === 'video');
  log('full recording', rv.codec_name, `${rv.width}x${rv.height}`, pr.format.duration);
  assert(rv.codec_name === 'h264' && rv.width === 1280 && Number(pr.format.duration) > 2, 'full-screen recording is a valid mp4');
  assert(!app.windows().some((w) => w.url().includes('control.html')), 'bar closed');

  // ---------------- screen recording: region chosen with the mouse + microphone
  await page.click('.nav-item[data-page="record"]');
  await page.click('#rec-audio [data-value="mic"]');
  await page.click('label:has(#rec-countdown)');
  await page.click('#rec-mode [data-value="region"]');
  let ov = null;
  for (let i = 0; i < 50 && !ov; i++) { ov = app.windows().find((w) => w.url().includes('region.html')); if (!ov) await page.waitForTimeout(100); }
  assert(ov, 'region overlay opened');
  await ov.waitForSelector('#ov');
  await ov.mouse.move(200, 150);
  await ov.mouse.down();
  await ov.mouse.move(500, 300, { steps: 6 });
  await ov.mouse.move(840, 510, { steps: 6 });
  await ov.mouse.up();
  await ov.waitForSelector('#bar:not([hidden])');
  await ov.screenshot({ path: path.join(SHOTS, '06f-region-overlay.png') });
  await ov.click('#ok');
  await page.waitForFunction(() => /640×360/.test(document.querySelector('#rec-region-text').textContent), null, { timeout: 5000 });
  await shot('06g-record-region-light');
  await stubDialog([], OUT);
  await page.click('#rec-start');
  await page.waitForFunction(() => document.body.dataset.rec === 'recording', null, { timeout: 15000 });
  let fr = false;
  for (let i = 0; i < 40 && !fr; i++) { fr = app.windows().some((w) => w.url().includes('frame.html')); if (!fr) await page.waitForTimeout(100); }
  assert(fr, 'region frame shown');
  await page.waitForTimeout(2500);
  await page.click('#rec-stop');
  await page.waitForSelector('#page-queue.active', { timeout: 20000 });
  states = await waitJobs(9, 120000);
  assert(states[0].includes('done'), 'region recording saved');
  const recs = fs.readdirSync(OUT).filter((f) => f.startsWith('ضبط صفحه')).sort();
  pr = probe(path.join(OUT, recs[recs.length - 1]));
  const v2 = pr.streams.find((x) => x.codec_type === 'video');
  const a2 = pr.streams.find((x) => x.codec_type === 'audio');
  log('region recording', `${v2.width}x${v2.height}`, a2 && a2.codec_name, pr.format.duration);
  assert(v2.width === 640 && v2.height === 360, 'region crop size');
  // Xvfb has no microphone: recording must continue without it (mic mixing is covered by web-e2e)
  assert(!a2, 'no audio without a microphone device');
  const tmpLeft = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('mediayar-rec-') && !tmpBefore.includes(f));
  assert(tmpLeft.length === 0, `temp captures cleaned: ${tmpLeft}`);
  await page.click('.nav-item[data-page="record"]');
  await page.click('#rec-mode [data-value="full"]');
  await page.click('#rec-audio [data-value="none"]');
  await page.click('label:has(#rec-countdown)');

  // ---------------- dark mode
  await page.click('[data-theme-btn="dark"]');
  await shot('07-queue-dark');
  await page.click('.nav-item[data-page="editor"]');
  await page.click('#ed-cutmode [data-value="remove"]');
  await page.evaluate(() => { document.querySelector('.main').scrollTop = 0; });
  await shot('08-editor-dark');
  await page.click('.nav-item[data-page="video"]');
  await stubDialog([path.join(FIX, 'sample.mp4'), path.join(FIX, 'stereo.wav')]);
  await page.click('#video-drop');
  await page.waitForFunction(() => document.querySelectorAll('#video-files .file:not(.loading)').length === 2);
  await page.click('#video-format [data-value="webm"]');
  await shot('09-video-dark');
  await page.click('.nav-item[data-page="audio"]');
  await shot('10-audio-dark');
  await page.click('.nav-item[data-page="record"]');
  await shot('10b-record-dark');

  // ---------------- cancel from UI
  await page.click('.nav-item[data-page="video"]');
  await page.click('#video-clear');
  await stubDialog([path.join(FIX, 'big.mp4')]);
  await page.click('#video-drop');
  await page.waitForFunction(() => document.querySelectorAll('#video-files .file:not(.loading)').length === 1);
  await page.click('#video-start');
  await page.waitForFunction(() => document.querySelector('.job.running'), null, { timeout: 20000 });
  await page.waitForTimeout(2000);
  await shot('11-queue-running-dark');
  await page.click('.job.running .btn.danger');
  await page.waitForFunction(() => document.querySelector('.job').classList.contains('canceled'), null, { timeout: 10000 });
  log('cancel ok');

  await page.reload();
  await page.waitForSelector('body[data-ready="1"]');
  assert((await page.getAttribute('html', 'data-theme')) === 'dark', 'theme persisted');
  assert((await page.$$eval('.job', (e) => e.length)) >= 10, 'queue restored after reload');

  log('outputs:', fs.readdirSync(OUT).join(', '));
  assert(errors.length === 0, `renderer errors: ${errors.join('\n')}`);
  await app.close();
  console.log('E2E PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED', e);
  process.exit(1);
});
