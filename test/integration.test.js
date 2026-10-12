'use strict';
/** End-to-end conversions with the real ffmpeg binary, verified with ffprobe. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('../src/core/formats');
const { JobQueue } = require('../src/core/queue');
const { NodeHost } = require('../src/core/node-host');
const { runner, tmpDir, runJobs, vstream, astreams, sstreams, dur, fx } = require('./helpers');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const ok = (j) => assert.equal(j.status, 'done', `${j.name} -> ${j.error} ${j.errorDetails || ''}`);

const EXPECT_V = { mp4: 'h264', mkv: 'h264', avi: 'mpeg4', mov: 'h264', wmv: 'wmv2', webm: 'vp9', flv: 'h264', mpg: 'mpeg2video', ts: 'h264', m4v: 'h264', '3gp': 'h264', ogv: 'theora', gif: 'gif' };

test('video: mp4 -> every format (re-encode) and back to mp4', { timeout: 600000 }, async () => {
  const out = tmpDir('vid');
  const specs = Object.keys(F.VIDEO_FORMATS).map((format) => ({ kind: 'video', input: fx('sample.mp4'), outputDir: out, opts: { format, quality: 'low', speed: 'fast', resolution: 360 } }));
  const jobs = await runJobs(specs);
  for (const j of jobs) {
    ok(j);
    const p = await runner.probe(j.output);
    const fmt = path.extname(j.output).slice(1);
    assert.equal(vstream(p).codec_name, EXPECT_V[fmt], fmt);
    if (fmt !== 'gif') {
      near(dur(p), 8, 0.6, fmt);
      assert.ok(astreams(p).length === 1, `${fmt} audio`);
      assert.equal(Math.min(vstream(p).width, vstream(p).height), 360, `${fmt} height`);
    }
  }
  // ...and every produced file back to MP4 (smart copy on, auto falls back to encode)
  const back = await runJobs(jobs.filter((j) => !j.output.endsWith('.gif')).map((j) => ({ kind: 'video', input: j.output, outputDir: tmpDir('back'), opts: { format: 'mp4', quality: 'low', speed: 'fast', smartCopy: true } })));
  for (const j of back) {
    ok(j);
    const p = await runner.probe(j.output);
    assert.ok(['h264', 'mpeg4'].includes(vstream(p).codec_name));
    near(dur(p), 8, 0.6, j.name);
  }
});

test('video: smart copy remux is lossless and fast; mkv tracks + subtitles preserved', { timeout: 120000 }, async () => {
  const out = tmpDir('remux');
  const [toMkv, toMp4] = await runJobs([
    { kind: 'video', input: fx('sample.mp4'), outputDir: out, opts: { format: 'mkv', smartCopy: true } },
    { kind: 'video', input: fx('multi.mkv'), outputDir: out, opts: { format: 'mp4', smartCopy: true } },
  ]);
  ok(toMkv); ok(toMp4);
  const p1 = await runner.probe(toMkv.output);
  assert.equal(vstream(p1).codec_name, 'h264');
  const p2 = await runner.probe(toMp4.output);
  assert.equal(astreams(p2).length, 2, 'both audio tracks kept');
  assert.equal(sstreams(p2)[0].codec_name, 'mov_text', 'srt converted to mov_text');
  assert.ok(['aac', 'vorbis'].includes(astreams(p2)[1].codec_name) === true);
});

test('video: odd dimensions, no audio, rotated portrait, unicode path', { timeout: 120000 }, async () => {
  const out = tmpDir('edge');
  const jobs = await runJobs([
    { kind: 'video', input: fx('odd_noaudio.avi'), outputDir: out, opts: { format: 'mp4', quality: 'low', speed: 'fast' } },
    { kind: 'video', input: fx('portrait_rot.mp4'), outputDir: out, opts: { format: 'mkv', resolution: 480, speed: 'fast' } },
    { kind: 'video', input: fx('ویدیو تست با فاصله.mp4'), opts: { format: 'webm', quality: 'low', speed: 'fast', resolution: 360 } },
  ]);
  jobs.forEach(ok);
  const [a, b, c] = await Promise.all(jobs.map((j) => runner.probe(j.output)));
  assert.equal(vstream(a).width % 2, 0);
  assert.equal(astreams(a).length, 0);
  assert.deepEqual([vstream(b).width, vstream(b).height], [480, 854], 'portrait scaled by short side');
  assert.ok(jobs[2].output.includes('ویدیو تست با فاصله'));
  fs.rmSync(jobs[2].output);
});

test('audio: every format from wav, 5.1 flac and from a video file', { timeout: 300000 }, async () => {
  const out = tmpDir('aud');
  const specs = [];
  for (const format of Object.keys(F.AUDIO_FORMATS)) {
    specs.push({ kind: 'audio', input: fx('stereo.wav'), outputDir: out, opts: { format, kbps: 128 } });
    specs.push({ kind: 'audio', input: fx('surround51.flac'), outputDir: out, opts: { format, kbps: 256, sampleRate: 44100 } });
  }
  specs.push({ kind: 'audio', input: fx('multi.mkv'), outputDir: out, opts: { format: 'mp3', kbps: 192, channels: 1, normalize: true } });
  const jobs = await runJobs(specs);
  for (const j of jobs) {
    ok(j);
    const p = await runner.probe(j.output);
    assert.equal(astreams(p).length, 1);
    assert.ok(!vstream(p), 'no video in audio output');
    near(dur(p), j.input.endsWith('.mkv') ? 8 : 6, 0.3, j.output);
  }
  const extracted = await runner.probe(jobs.at(-1).output);
  assert.equal(astreams(extracted)[0].channels, 1);
  assert.equal(Number(astreams(extracted)[0].sample_rate), 48000);
});

test('editor: trims, cut-out, crop, rotate, mute', { timeout: 300000 }, async () => {
  const out = tmpDir('edit');
  const input = fx('sample.mp4');
  const jobs = await runJobs([
    { kind: 'edit', input, outputDir: out, opts: { start: 2, end: 5 } },
    { kind: 'edit', input, outputDir: out, opts: { start: 2.5, end: 5.5, precise: true } },
    { kind: 'edit', input, outputDir: out, opts: { start: 2, end: 4, cutMode: 'remove' } },
    { kind: 'edit', input, outputDir: out, opts: { start: 0, end: 3, cutMode: 'remove', format: 'mkv' } },
    { kind: 'edit', input, outputDir: out, opts: { crop: '1:1', rotate: 90, mute: true, format: 'webm' } },
    { kind: 'edit', input, outputDir: out, opts: { crop: '9:16', flip: 'h' } },
  ]);
  jobs.forEach(ok);
  const p = await Promise.all(jobs.map((j) => runner.probe(j.output)));
  near(dur(p[0]), 3, 1.1, 'fast trim (keyframe aligned)');
  near(dur(p[1]), 3, 0.1, 'precise trim');
  near(dur(p[2]), 6, 0.15, 'removed middle');
  near(dur(p[3]), 5, 0.15, 'removed head');
  assert.equal(astreams(p[2]).length, 1);
  assert.deepEqual([vstream(p[4]).width, vstream(p[4]).height], [720, 720]);
  assert.equal(astreams(p[4]).length, 0, 'muted');
  assert.equal(vstream(p[4]).codec_name, 'vp9');
  assert.deepEqual([vstream(p[5]).width, vstream(p[5]).height], [404, 720]);
  assert.ok(jobs[0].output.endsWith('_edited.mp4'));
});

test('editor: compression targets (1/2, 1/3, 1/4, fixed MB, smart, HEVC)', { timeout: 1500000 }, async () => {
  const out = tmpDir('cmp');
  const input = fx('big.mp4');
  const src = fs.statSync(input).size;
  const cases = [
    { opts: { compress: { mode: 'ratio', ratio: 1 / 2, codec: 'h264', resolution: 'auto' } }, target: src / 2 },
    { opts: { compress: { mode: 'ratio', ratio: 1 / 3, codec: 'h264', resolution: 'auto' } }, target: src / 3 },
    { opts: { compress: { mode: 'ratio', ratio: 1 / 4, codec: 'h265', resolution: 'original' } }, target: src / 4 },
    { opts: { compress: { mode: 'size', sizeMB: 5, codec: 'h264', resolution: 'auto' } }, target: 5 * 1024 * 1024 },
    { opts: { start: 5, end: 15, compress: { mode: 'ratio', ratio: 1 / 2, codec: 'h264', resolution: 'auto' } }, target: src / 4 },
    { opts: { start: 3, end: 15.5, cutMode: 'remove', crop: '1:1', compress: { mode: 'ratio', ratio: 1 / 2, codec: 'h264', resolution: 'auto' } }, target: (src * 7.5) / 20 / 2 },
    { opts: { compress: { mode: 'smart', codec: 'h264', resolution: 720 } }, max: src / 2 },
    { opts: { compress: { mode: 'smart', codec: 'h265', resolution: 'original' } }, max: src / 2 },
  ];
  const jobs = await runJobs(cases.map((c) => ({ kind: 'edit', input, outputDir: out, opts: c.opts })));
  jobs.forEach((j, i) => {
    ok(j);
    const c = cases[i];
    if (c.target) {
      const err = Math.abs(j.outputSize - c.target) / c.target;
      assert.ok(err < 0.12, `case ${i}: size ${j.outputSize} vs target ${Math.round(c.target)} (err ${(err * 100).toFixed(1)}%)`);
    } else assert.ok(j.outputSize < c.max, `case ${i}: ${j.outputSize} < ${c.max}`);
  });
  const hevc = await runner.probe(jobs[2].output);
  assert.equal(vstream(hevc).codec_name, 'hevc');
  assert.equal(vstream(hevc).codec_tag_string, 'hvc1');
});

test('cancel stops ffmpeg and removes partial output', { timeout: 60000 }, async () => {
  const q = new JobQueue(new NodeHost(runner));
  const out = tmpDir('cancel');
  const final = await new Promise((resolve) => {
    let canceled = false;
    q.on('update', (j) => {
      if (j.status === 'running' && j.progress > 0.05 && !canceled) {
        canceled = true;
        q.cancel(j.id);
      }
      if (['done', 'error', 'canceled'].includes(j.status)) resolve(j);
    });
    q.add([{ kind: 'video', input: fx('big.mp4'), outputDir: out, opts: { format: 'webm', speed: 'best', quality: 'high' } }]);
  });
  assert.equal(final.status, 'canceled');
  assert.deepEqual(fs.readdirSync(out), []);
});

test('broken input gives a friendly error', { timeout: 30000 }, async () => {
  const dir = tmpDir('bad');
  const bad = path.join(dir, 'broken.mp4');
  fs.writeFileSync(bad, Buffer.alloc(4096, 7));
  const [j] = await runJobs([{ kind: 'video', input: bad, opts: { format: 'mkv' } }]);
  assert.equal(j.status, 'error');
  assert.match(j.error, /فایل/);
});

test('save-as: exact outputPath, extension fixed, no partial files left', { timeout: 60000 }, async () => {
  const dir = tmpDir('saveas');
  const want = path.join(dir, 'sub folder', 'خروجی من');
  const [j] = await runJobs([{ kind: 'audio', input: fx('stereo.wav'), outputPath: want, opts: { format: 'mp3', quality: 'low' } }]);
  ok(j);
  assert.equal(j.output, `${want}.mp3`);
  assert.deepEqual(fs.readdirSync(path.dirname(want)), ['خروجی من.mp3']);
  // replacing an existing file the user confirmed in the dialog
  fs.writeFileSync(path.join(dir, 'x.mp4'), 'old');
  const [k] = await runJobs([{ kind: 'edit', input: fx('sample.mp4'), outputPath: path.join(dir, 'x.mp4'), opts: { start: 1, end: 3 } }]);
  ok(k);
  near(dur(await runner.probe(k.output)), 2, 0.3, 'replaced');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['sub folder', 'x.mp4']);
});

test('record: raw webm capture (no duration, odd size) -> seekable mp4, crop, temp input removed', { timeout: 120000 }, async () => {
  const dir = tmpDir('rec');
  const raw = path.join(dir, 'raw.webm');
  // emulate a MediaRecorder file: vp8 + opus, odd dimensions, streamed (no cues/duration)
  const { execFileSync } = require('child_process');
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1279x719:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3',
    '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus', '-live', '1', '-f', 'webm', 'pipe:1'], { stdio: ['ignore', fs.openSync(raw, 'w'), 'inherit'] });
  const copy = path.join(dir, 'raw2.webm');
  const copy3 = path.join(dir, 'raw3.webm');
  fs.copyFileSync(raw, copy);
  fs.copyFileSync(raw, copy3);
  const out1 = path.join(dir, 'Recording 1.mp4');
  const out2 = path.join(dir, 'Recording 2.mp4');
  const out3 = path.join(dir, 'Recording 3.webm');
  const [a, b, c] = await runJobs([
    { kind: 'record', input: raw, tempInput: true, outputPath: out1, name: 'ضبط صفحه', opts: { duration: 3 } },
    { kind: 'record', input: copy, tempInput: true, outputPath: out2, opts: { duration: 3, crop: { x: 101 / 1279, y: 51 / 719, w: 641 / 1279, h: 361 / 719, unit: 'ratio' }, quality: 'medium' } },
    { kind: 'record', input: copy3, tempInput: true, outputPath: out3, opts: { duration: 3, container: 'webm' } },
  ]);
  ok(a);
  ok(b);
  ok(c);
  assert.equal(a.name, 'ضبط صفحه');
  const p1 = await runner.probe(out1);
  assert.equal(vstream(p1).codec_name, 'h264');
  assert.equal(vstream(p1).width, 1278);
  assert.equal(astreams(p1)[0].codec_name, 'aac');
  near(dur(p1), 3, 0.3, 'rec duration');
  const p2 = await runner.probe(out2);
  assert.equal(vstream(p2).width, 640);
  assert.equal(vstream(p2).height, 360);
  const p3 = await runner.probe(out3);
  assert.equal(vstream(p3).codec_name, 'vp8');
  near(dur(p3), 3, 0.3, 'webm remux has duration');
  assert.ok(![raw, copy, copy3].some((f) => fs.existsSync(f)), 'temp inputs removed');
});
