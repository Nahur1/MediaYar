'use strict';
const { _electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const root = path.join(__dirname,'..');
const output = fs.mkdtempSync(path.join(os.tmpdir(),'mediayar-desktop-'));
(async () => {
  const app = await _electron.launch({ executablePath: process.env.ELECTRON_BIN || path.join(root,'builds','win64','MediaYar.exe'), args: process.env.MEDIAYAR_PACKAGED ? [] : [root] });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('body[data-ready="1"]');
    await app.evaluate(({ dialog }, [input, output]) => {
      dialog.showOpenDialog = async () => ({canceled:false, filePaths:[input]});
      dialog.showSaveDialog = async () => ({canceled:false, filePath:output});
    }, [path.join(__dirname,'fixtures','stereo.wav'),path.join(output,'صوت آزمایشی.mp3')]);
    await page.click('[data-page="audio"]');
    await page.click('#audio-drop');
    await page.waitForSelector('#audio-files .file:not(.loading)');
    await page.click('#audio-format [data-value="mp3"]');
    await page.click('#audio-start');
    await page.waitForSelector('.job.done', {timeout:60000});
    const probe = JSON.parse(execFileSync(process.env.FFPROBE || 'ffprobe',['-v','error','-show_streams','-of','json',path.join(output,'صوت آزمایشی.mp3')],{encoding:'utf8'}));
    assert.equal(probe.streams[0].codec_name,'mp3');
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]');
    await page.click('[data-page="queue"]');
    await page.waitForSelector('.job.done');
    assert.deepEqual(errors, []);
    console.log('PASS Electron preload/IPC, native file dialogs, real audio export, and queue recovery after reload.');
  } finally { await app.close(); }
})().catch(e => {console.error(e); process.exitCode=1;});
