'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const shots = path.join(__dirname, 'shots-ui');
(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage();
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:8080');
    await page.waitForSelector('body[data-ready="1"]');
    const upload = async (selector, name) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'),page.click(selector)]);
      await chooser.setFiles(path.join(__dirname, 'fixtures', name));
    };
    await page.click('[data-page="editor"]');
    await upload('#editor-drop','sample.mp4');
    await page.waitForSelector('#editor:not([hidden])', { timeout: 120000 });
    await page.click('[data-page="video"]');
    await upload('#video-drop','sample.mp4');
    await page.waitForSelector('#video-files .file:not(.loading)', { timeout: 120000 });
    await page.click('[data-page="audio"]');
    await upload('#audio-drop','stereo.wav');
    await page.waitForSelector('#audio-files .file:not(.loading)', { timeout: 120000 });
    await page.evaluate(async () => {
      const input = api.pathForFile(new File(['broken'], 'فایل خراب با نام بسیار طولانی '.repeat(8) + '.mp4'));
      await api.addJobs([{ kind: 'video', input, opts: { format: 'mp4' } }]);
    });
    await page.waitForSelector('.job.error', { state: 'attached', timeout: 120000 });
    let checks = 0;
    for (const width of [320,390,760,1024,1440]) {
      await page.setViewportSize({width,height:900});
      for (const theme of ['light','dark']) {
        await page.click(`[data-theme-btn="${theme}"]`);
        for (const section of ['video','audio','editor','record','queue']) {
          await page.click(`[data-page="${section}"]`);
          await page.waitForTimeout(220);
          const bad = await page.evaluate(() => {
            const main = document.querySelector('.main');
            const failures = [];
            if (main.scrollWidth > main.clientWidth + 2) failures.push(`main: ${main.scrollWidth} > ${main.clientWidth}`);
            for (const el of document.querySelectorAll('.page.active button,.page.active input,.page.active select,.page.active .panel,.sidebar')) {
              if (!el.getClientRects().length) continue;
              const r = el.getBoundingClientRect();
              if (r.left < -1 || r.right > innerWidth + 1) failures.push(`${el.id || el.className}: ${r.left}..${r.right}`);
            }
            return failures;
          });
          assert.deepEqual(bad, [], `${width}/${theme}/${section}: ${bad.join(', ')}`);
          const reachable = await page.locator(`.nav-item[data-page="${section}"]`).evaluate(el => {
            const r = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
          });
          assert.ok(reachable, `navigation reachable: ${width}/${theme}/${section}`);
          checks++;
          if ([390,1440].includes(width)) await page.screenshot({path:path.join(shots,`${width}-${theme}-${section}.png`),fullPage:true});
        }
        await page.click('[data-page="video"]');
        await page.click('#video-start');
        await page.waitForSelector('.modal');
        const modalFits = await page.locator('.modal').evaluate(el => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth + 1;
        });
        assert.ok(modalFits, `save dialog fits: ${width}/${theme}`);
        await page.keyboard.press('Escape');
      }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${checks} page/theme/viewport combinations, populated editor/video/audio/error queue, 10 save dialogs and navigation hit targets; no runtime errors.`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
