'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/media');
const P = require('../src/core/planner');
const F = require('../src/core/formats');
const { outputPathFor } = require('../src/core/node-host');
const path = require('path');
const { FIX, fx } = require('./helpers');

const fakeProbe = (o = {}) => ({
  format: { duration: String(o.duration || 60), size: String(o.size || 60_000_000), bit_rate: '8000000' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: o.vcodec || 'h264', width: o.w || 1920, height: o.h || 1080, avg_frame_rate: '30/1', side_data_list: o.rot ? [{ rotation: o.rot }] : undefined },
    ...(o.noAudio ? [] : [{ index: 1, codec_type: 'audio', codec_name: o.acodec || 'aac', channels: o.ch || 2, sample_rate: '48000' }]),
    ...(o.subs || []),
  ],
});
const argsOf = (plan, out = 'out') => plan.build(out).map((p) => p.args);
const has = (args, ...seq) => args.some((_, i) => seq.every((s, k) => args[i + k] === s));

test('time parsing / formatting', () => {
  assert.equal(M.parseTime('1:02:03.5'), 3723.5);
  assert.equal(M.parseTime('90'), 90);
  assert.equal(M.parseTime('۱:۳۰'), 90);
  assert.equal(M.parseTime('2,5'), 2.5);
  assert.ok(Number.isNaN(M.parseTime('abc')));
  assert.ok(Number.isNaN(M.parseTime('')));
  assert.equal(M.formatTime(3723.5), '01:02:03.500');
  assert.equal(M.formatTime(0, false), '00:00:00');
});

test('scaling keeps aspect, even dims, never upscales, handles portrait', () => {
  assert.deepEqual(M.scaleToShortSide(1920, 1080, 720), { w: 1280, h: 720 });
  assert.deepEqual(M.scaleToShortSide(1080, 1920, 720), { w: 720, h: 1280 });
  assert.deepEqual(M.scaleToShortSide(853, 480, 360), { w: 640, h: 360 });
  assert.equal(M.scaleToShortSide(1280, 720, 1080), null);
});

test('crop for aspect ratio is centered and even', () => {
  assert.deepEqual(M.cropForAspect(1920, 1080, 1, 1), { w: 1080, h: 1080, x: 420, y: 0 });
  assert.deepEqual(M.cropForAspect(1920, 1080, 9, 16), { w: 606, h: 1080, x: 657, y: 0 });
  assert.equal(M.cropForAspect(1920, 1080, 16, 9), null);
  const r = M.cropForAspect(1280, 720, 4, 3);
  assert.equal(r.w % 2 + r.h % 2, 0);
});

test('rotation metadata swaps display dims', () => {
  assert.deepEqual(M.displayDims({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }), { w: 1080, h: 1920 });
  assert.deepEqual(M.displayDims({ width: 1920, height: 1080, tags: { rotate: '180' } }), { w: 1920, h: 1080 });
});

test('bitrate planning hits budget and rejects impossible targets', () => {
  const p = M.planBitrate({ targetBytes: 10 * 1024 * 1024, duration: 60, hasAudio: true });
  assert.ok(p.ok);
  const total = ((p.videoKbps + p.audioKbps) * 60 * 1000) / 8;
  assert.ok(total < 10 * 1024 * 1024 && total > 9.5 * 1024 * 1024 * 0.95);
  assert.equal(M.planBitrate({ targetBytes: 100_000, duration: 600, hasAudio: true }).ok, false);
});

test('auto resolution steps down when bits-per-pixel is too low', () => {
  assert.equal(M.autoResolution({ w: 1920, h: 1080, fps: 30, videoKbps: 8000, bppFloor: 0.05 }), null);
  const d = M.autoResolution({ w: 1920, h: 1080, fps: 30, videoKbps: 800, bppFloor: 0.05 });
  assert.ok(d && d.h < 1080);
});

test('smart copy only when container accepts source codecs', () => {
  const p = fakeProbe();
  assert.equal(P.planVideo({ input: 'a.mkv', probe: p, opts: { format: 'mp4', smartCopy: true } }).info.videoMode, 'copy');
  assert.equal(P.planVideo({ input: 'a.mkv', probe: p, opts: { format: 'webm', smartCopy: true } }).info.videoMode, 'encode');
  assert.equal(P.planVideo({ input: 'a.mkv', probe: p, opts: { format: 'mp4', smartCopy: true, resolution: 720 } }).info.videoMode, 'encode');
  assert.equal(P.planVideo({ input: 'a.mkv', probe: p, opts: { format: 'mp4', smartCopy: false } }).info.videoMode, 'encode');
});

test('every video format plans without throwing', () => {
  for (const key of Object.keys(F.VIDEO_FORMATS)) {
    const plan = P.planVideo({ input: 'in.mov', probe: fakeProbe({ ch: 6 }), opts: { format: key, quality: 'medium' } });
    const [a] = argsOf(plan);
    assert.equal(a.at(-1), 'out', key);
  }
});

test('hevc to mp4 gets hvc1 tag; subtitles converted to mov_text', () => {
  const subs = [{ index: 2, codec_type: 'subtitle', codec_name: 'subrip' }, { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' }];
  const plan = P.planVideo({ input: 'a.mkv', probe: fakeProbe({ vcodec: 'hevc', subs }), opts: { format: 'mp4', smartCopy: true } });
  const [a] = argsOf(plan);
  assert.ok(has(a, '-tag:v', 'hvc1'));
  assert.ok(has(a, '-c:s:0', 'mov_text'));
  assert.equal(plan.info.subtitleTracks, 1); // bitmap subs are dropped for mp4
});

test('opus/mp3 downmix multichannel, lossless ignores bitrate', () => {
  assert.ok(has(P.audioEncoderArgs('opus', { kbps: 128, srcChannels: 6 }), '-ac', '2'));
  assert.ok(has(P.audioEncoderArgs('opus', { sampleRate: 44100 }), '-ar', '48000'));
  assert.ok(!P.audioEncoderArgs('flac', { kbps: 320 }).includes('-b:a'));
  assert.ok(has(P.audioEncoderArgs('wma', { kbps: 320 }), '-b:a', '192k'));
});

test('editor: lossless trim uses stream copy and source container', () => {
  const plan = P.planEdit({ input: 'clip.mkv', probe: fakeProbe(), opts: { start: 5, end: 20 } });
  assert.equal(plan.info.mode, 'copy');
  assert.equal(plan.ext, 'mkv');
  assert.equal(plan.duration, 15);
  const [a] = argsOf(plan);
  assert.ok(has(a, '-ss', '5.000') && has(a, '-t', '15.000') && has(a, '-c', 'copy'));
});

test('editor: remove middle section concatenates both sides', () => {
  const plan = P.planEdit({ input: 'clip.mp4', probe: fakeProbe(), opts: { start: 10, end: 20, cutMode: 'remove' } });
  assert.equal(plan.duration, 50);
  const a = argsOf(plan)[0];
  const g = a[a.indexOf('-filter_complex') + 1];
  assert.match(g, /concat=n=2:v=1:a=1/);
  assert.match(g, /trim=start=0.000:end=10.000/);
  assert.match(g, /trim=start=20.000,/);
});

test('editor: ratio compression uses two passes and the right budget', () => {
  const plan = P.planEdit({ input: 'clip.mp4', probe: fakeProbe(), opts: { compress: { mode: 'ratio', ratio: 1 / 3, codec: 'h264', resolution: 'original' } } });
  assert.equal(plan.info.targetBytes, 20_000_000);
  const passes = argsOf(plan);
  assert.equal(passes.length, 2);
  assert.ok(has(passes[0], '-pass', '1') && has(passes[1], '-pass', '2'));
  assert.ok(passes[0].includes('-an'));
});

test('editor: x265 two-pass uses relative stats file', () => {
  const plan = P.planEdit({ input: 'c.mp4', probe: fakeProbe(), opts: { compress: { mode: 'size', sizeMB: 10, codec: 'h265' } } });
  const [p1, p2] = argsOf(plan);
  assert.ok(p1[p1.indexOf('-x265-params') + 1].includes('pass=1:stats=x265pass.log'));
  assert.ok(p2[p2.indexOf('-x265-params') + 1].includes('pass=2'));
});

test('editor: validation errors are user facing', () => {
  const probe = fakeProbe();
  assert.throws(() => P.planEdit({ input: 'c.mp4', probe, opts: {} }), P.PlanError);
  assert.throws(() => P.planEdit({ input: 'c.mp4', probe, opts: { start: 0, end: 60, cutMode: 'remove' } }), P.PlanError);
  assert.throws(() => P.planEdit({ input: 'c.mp4', probe, opts: { compress: { mode: 'size', sizeMB: 500 } } }), /بیشتر/);
  assert.throws(() => P.planEdit({ input: 'c.mp4', probe, opts: { compress: { mode: 'size', sizeMB: 0.01 } } }), /خیلی کم/);
});

test('editor: crop + rotate updates output dims', () => {
  const plan = P.planEdit({ input: 'c.mp4', probe: fakeProbe(), opts: { crop: '4:3', rotate: 90 } });
  assert.deepEqual([plan.info.width, plan.info.height], [1080, 1440]); // 1920x1080 -> 1440x1080 -> rotated
});

test('output naming never overwrites and avoids the input', () => {
  const p = outputPathFor(fx('sample.mp4'), 'mp4');
  assert.equal(path.basename(p), 'sample_converted.mp4');
  assert.equal(path.basename(outputPathFor(fx('sample.mp4'), 'mkv')), 'sample.mkv');
  assert.equal(path.basename(outputPathFor(fx('sample.mp4'), 'mp4', { suffix: 'edited' })), 'sample_edited.mp4');
  assert.equal(path.basename(outputPathFor(path.join(FIX, 'big.mp4'), 'mp4', { outputDir: FIX, suffix: undefined })), 'big_converted.mp4');
});

test('catalog is serialisable', () => {
  const c = JSON.parse(JSON.stringify(F.catalog()));
  assert.ok(c.videoFormats.mp4 && c.audioFormats.flac.lossless);
});

/* ---------------------------------------------------------- screen recording planner */
test('planRecord: copy h264+aac, crop ratios, webm remux, duration hint', () => {
  const { planRecord } = require('../src/core/planner');
  const probe = (vc, ac, w = 1920, h = 1080, dur) => ({
    format: dur ? { duration: String(dur) } : {},
    streams: [{ index: 0, codec_type: 'video', codec_name: vc, width: w, height: h }, ...(ac ? [{ index: 1, codec_type: 'audio', codec_name: ac, channels: 2 }] : [])],
  });
  const a1 = planRecord({ input: 'in.mp4', probe: probe('h264', 'aac'), opts: { duration: 12.5 } });
  assert.equal(a1.ext, 'mp4');
  assert.equal(a1.duration, 12.5);
  const j1 = a1.build('out.mp4')[0].args.join(' ');
  assert.ok(j1.includes('-c:v copy') && j1.includes('-c:a copy') && j1.includes('+faststart'), j1);

  const a2 = planRecord({ input: 'in.webm', probe: probe('vp8', 'opus', 2560, 1440), opts: { crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5, unit: 'ratio' } } });
  const j2 = a2.build('o.mp4')[0].args.join(' ');
  assert.ok(j2.includes('crop=1280:720:640:360'), j2);
  assert.ok(j2.includes('libx264') && j2.includes('-c:a aac'));
  assert.equal(a2.info.width, 1280);

  const a3 = planRecord({ input: 'in.webm', probe: probe('vp9', 'opus'), opts: { container: 'webm' } });
  assert.equal(a3.ext, 'webm');
  assert.ok(a3.build('o.webm')[0].args.join(' ').includes('-c copy'));
  assert.equal(planRecord({ input: 'x', probe: probe('vp9', 'opus'), opts: { container: 'webm', crop: { x: 0, y: 0, w: 0.5, h: 0.5, unit: 'ratio' } } }).ext, 'mp4');
  const a4 = planRecord({ input: 'x', probe: probe('h264', null, 1279, 719), opts: { crop: { x: 0.9, y: 0.9, w: 0.5, h: 0.5, unit: 'ratio' } } });
  const m = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(a4.build('o')[0].args.join(' '));
  assert.ok(m && +m[1] + +m[3] <= 1279 && +m[2] + +m[4] <= 719 && m[1] % 2 === 0, m && m[0]);
  assert.ok(a4.build('o')[0].args.includes('-an'));
});
