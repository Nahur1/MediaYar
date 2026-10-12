'use strict';
/**
 * Turns (probe result + user options) into exact ffmpeg argument lists.
 * Everything here is pure and synchronous so it can be unit-tested in isolation.
 *
 * Every planner returns:
 *   { ext, duration, info, build(outputPath) -> [{ args, weight }] }
 * `duration` is the expected output duration (used for progress),
 * `info` is a human-facing summary the UI can preview before running.
 */
const F = require('./formats');
const M = require('./media');

class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
    this.userFacing = true;
  }
}

const HEAD = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
const tail = (output) => ['-progress', 'pipe:1', '-nostats', output];
const QUALITIES = ['high', 'medium', 'low'];
const X26X_PRESET = { fast: 'veryfast', balanced: 'medium', best: 'slow' };
const VPX_CPU = { fast: 6, balanced: 4, best: 2 };
const MP4_LIKE = new Set(['mp4', 'mov', 'm4v', '3gp']);
const COPY_SAFE_EXT = new Set(['mp4', 'mkv', 'mov', 'm4v', 'webm', 'avi', 'ts', 'mts', 'm2ts', 'flv', '3gp', 'mpg', 'mpeg', 'wmv', 'ogv']);

// Both passes of a 2-pass encode must use an identical encoder time base
// (otherwise x264 aborts with "timebase mismatch with 1st pass").
const PASS_TB = ['-fps_mode', 'passthrough', '-enc_time_base:v', '1/90000'];
const t3 = (s) => (Math.round(s * 1000) / 1000).toFixed(3);
const accepts = (list, codec) => list === F.ANY || (Array.isArray(list) && list.includes(codec));
const pickQuality = (q) => (QUALITIES.includes(q) ? q : 'high');
const pickSpeed = (s) => (X26X_PRESET[s] ? s : 'balanced');

/* ------------------------------------------------------------------ encoders */

/**
 * @param {string} key  VIDEO_CODECS key
 * @param {{quality?:string, kbps?:number, speed?:string, pass?:1|2, container?:string}} o
 */
function videoEncoderArgs(key, o = {}) {
  const c = F.VIDEO_CODECS[key];
  if (!c) throw new PlanError(`کدک ویدیویی پشتیبانی نمی‌شود: ${key}`);
  const q = c.quality[pickQuality(o.quality)];
  const speed = pickSpeed(o.speed);
  const a = ['-c:v', c.encoder];
  switch (c.family) {
    case 'x264':
      a.push('-preset', X26X_PRESET[speed]);
      if (o.kbps) {
        a.push('-b:v', `${o.kbps}k`);
        if (o.pass) a.push('-pass', String(o.pass), '-passlogfile', 'ffpass');
      } else a.push('-crf', String(q));
      a.push('-pix_fmt', 'yuv420p');
      break;
    case 'x265': {
      const params = ['log-level=error'];
      a.push('-preset', X26X_PRESET[speed]);
      if (o.kbps) {
        a.push('-b:v', `${o.kbps}k`);
        // Relative stats path: ffmpeg runs with cwd = job temp dir, which
        // avoids x265-params choking on the "C:" colon of Windows paths.
        if (o.pass) params.push(`pass=${o.pass}`, 'stats=x265pass.log');
      } else a.push('-crf', String(q));
      a.push('-x265-params', params.join(':'), '-pix_fmt', 'yuv420p');
      if (MP4_LIKE.has(o.container)) a.push('-tag:v', 'hvc1');
      break;
    }
    case 'vp9':
      a.push('-deadline', 'good', '-cpu-used', String(VPX_CPU[speed]), '-row-mt', '1', '-tile-columns', '2');
      if (o.kbps) {
        a.push('-b:v', `${o.kbps}k`);
        if (o.pass) a.push('-pass', String(o.pass), '-passlogfile', 'ffpass');
      } else a.push('-crf', String(q), '-b:v', '0');
      a.push('-pix_fmt', 'yuv420p');
      break;
    case 'vp8':
      a.push('-deadline', 'good', '-cpu-used', String(VPX_CPU[speed]));
      if (o.kbps) {
        a.push('-b:v', `${o.kbps}k`);
        if (o.pass) a.push('-pass', String(o.pass), '-passlogfile', 'ffpass');
      } else a.push('-crf', String(q), '-b:v', '12M');
      a.push('-pix_fmt', 'yuv420p');
      break;
    case 'qscale':
      a.push('-q:v', String(q), ...(c.extra || []), '-pix_fmt', 'yuv420p');
      break;
    case 'theora':
      a.push('-q:v', String(q), '-pix_fmt', 'yuv420p');
      break;
    default:
      throw new PlanError(`کدک ناشناخته: ${key}`);
  }
  return a;
}

/**
 * @param {string} key AUDIO_CODECS key
 * @param {{kbps?:number, srcChannels?:number, channels?:number, sampleRate?:number}} o
 */
function audioEncoderArgs(key, o = {}) {
  const c = F.AUDIO_CODECS[key];
  if (!c) throw new PlanError(`کدک صوتی پشتیبانی نمی‌شود: ${key}`);
  const a = ['-c:a', c.encoder, ...(c.extra || [])];
  if (c.fixed) return a.concat(['-ar', '8000', '-ac', '1', '-b:a', '12.2k']);
  let ch = Number(o.channels) || 0;
  const effective = ch || Number(o.srcChannels) || 2;
  if (c.maxChannels && effective > c.maxChannels) ch = c.maxChannels;
  if (!c.lossless && o.kbps) {
    let kbps = Number(o.kbps);
    if (c.maxKbps) kbps = Math.min(kbps, c.maxKbps);
    a.push('-b:a', `${kbps}k`);
  }
  if (ch) a.push('-ac', String(ch));
  let ar = Number(o.sampleRate) || 0;
  if (ar && c.rates && !c.rates.includes(ar)) ar = 48000;
  // Encoders with a fixed rate set (Opus): resample explicitly to the native 48 kHz
  // instead of relying on auto-negotiation (more robust, same result).
  if (!ar && c.rates) ar = 48000;
  if (ar) a.push('-ar', String(ar));
  return a;
}

/** Make sure dimensions are even (required by 4:2:0 encoders). */
function evenFix(dims) {
  if (!dims || (dims.w % 2 === 0 && dims.h % 2 === 0)) return null;
  return { w: M.floorEven(dims.w), h: M.floorEven(dims.h) };
}

/* ------------------------------------------------------------- video convert */

function planSubtitles(fmt, subs) {
  if (!fmt.subs) return [];
  const out = [];
  for (const s of subs) {
    const text = M.TEXT_SUBS.has(s.codec_name);
    if (fmt.subs === 'copy') out.push({ index: s.index, codec: s.codec_name === 'mov_text' ? 'srt' : 'copy' });
    else if (text) out.push({ index: s.index, codec: fmt.subs });
  }
  return out;
}

/**
 * @param {{probe:object, opts:{format:string, codec?:string, quality?:string,
 *   resolution?:string|number, speed?:string, smartCopy?:boolean}}} p
 */
function planVideo({ input, probe, opts }) {
  const fmt = F.VIDEO_FORMATS[opts.format];
  if (!fmt) throw new PlanError('فرمت خروجی نامعتبر است.');
  const v = M.pickVideoStream(probe);
  if (!v) throw new PlanError('این فایل تصویر ویدیویی ندارد. برای فایل‌های صوتی از بخش «تبدیل صوت» استفاده کنید.');
  const duration = M.durationOf(probe);
  const dims = M.displayDims(v) || { w: 0, h: 0 };
  const quality = pickQuality(opts.quality);
  if (fmt.gif) return planGif({ input, v, dims, duration, quality, opts });

  const res = Number(opts.resolution) || 0;
  const scale = (res && M.scaleToShortSide(dims.w, dims.h, res)) || null;
  const codecKey = fmt.codecs.includes(opts.codec) ? opts.codec : fmt.codecs[0];
  const audios = M.streamsOf(probe, 'audio');
  const mappedAudio = fmt.multiAudio ? audios : audios.slice(0, 1);
  const subs = planSubtitles(fmt, M.streamsOf(probe, 'subtitle'));
  const copyV = !!opts.smartCopy && !scale && accepts(fmt.copyV, v.codec_name);
  const copyA = !!opts.smartCopy && mappedAudio.length > 0 && mappedAudio.every((a) => accepts(fmt.copyA, a.codec_name));
  const outDims = scale || evenFix(dims) || dims;

  const build = (output) => {
    const a = [...HEAD, '-i', input, '-map', `0:${v.index}`];
    for (const s of mappedAudio) a.push('-map', `0:${s.index}`);
    for (const s of subs) a.push('-map', `0:${s.index}`);
    if (copyV) {
      a.push('-c:v', 'copy');
      if (v.codec_name === 'hevc' && MP4_LIKE.has(fmt.ext)) a.push('-tag:v', 'hvc1');
    } else {
      const sz = scale || evenFix(dims);
      if (sz) a.push('-vf', `scale=${sz.w}:${sz.h}:flags=lanczos`);
      a.push(...videoEncoderArgs(codecKey, { quality, speed: opts.speed, container: fmt.ext }));
    }
    if (!mappedAudio.length) a.push('-an');
    else if (copyA) a.push('-c:a', 'copy');
    else {
      const srcChannels = Math.max(...mappedAudio.map((s) => Number(s.channels) || 2));
      let kbps = F.VIDEO_AUDIO_KBPS[quality];
      if (fmt.audio === 'opus') kbps -= 32;
      const ac = F.AUDIO_CODECS[fmt.audio];
      if (srcChannels > 2 && !ac.maxChannels) kbps = Math.min(640, Math.round((kbps * srcChannels) / 2));
      a.push(...audioEncoderArgs(fmt.audio, { kbps, srcChannels }));
    }
    if (subs.length) subs.forEach((s, i) => a.push(`-c:s:${i}`, s.codec));
    else a.push('-sn');
    a.push('-map_metadata', '0', '-max_muxing_queue_size', '9999', ...(fmt.flags || []), ...tail(output));
    return [{ args: a, weight: 1 }];
  };

  return {
    ext: fmt.ext,
    duration,
    info: {
      videoMode: copyV ? 'copy' : 'encode',
      audioMode: !mappedAudio.length ? 'none' : copyA ? 'copy' : 'encode',
      codec: copyV ? v.codec_name : codecKey,
      width: outDims.w,
      height: outDims.h,
      audioTracks: mappedAudio.length,
      subtitleTracks: subs.length,
    },
    build,
  };
}

function planGif({ input, v, dims, duration, quality, opts }) {
  const preset = { high: { w: 640, fps: 15 }, medium: { w: 480, fps: 12 }, low: { w: 360, fps: 10 } }[quality];
  let tw = Math.min(preset.w, dims.w || preset.w);
  const res = Number(opts.resolution) || 0;
  if (res) {
    const s = M.scaleToShortSide(dims.w, dims.h, res);
    if (s) tw = Math.min(tw, s.w);
  }
  const th = dims.w ? M.even((dims.h * tw) / dims.w) : -2;
  const graph =
    `[0:${v.index}]fps=${preset.fps},scale=${tw}:${th}:flags=lanczos,split[s0][s1];` +
    '[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[g]';
  return {
    ext: 'gif',
    duration,
    info: { videoMode: 'encode', audioMode: 'none', codec: 'gif', width: tw, height: th, audioTracks: 0, subtitleTracks: 0 },
    build: (output) => [{ args: [...HEAD, '-i', input, '-filter_complex', graph, '-map', '[g]', '-loop', '0', ...tail(output)], weight: 1 }],
  };
}

/* ------------------------------------------------------------- audio convert */

/**
 * @param {{opts:{format:string, kbps?:number, sampleRate?:number, channels?:number, normalize?:boolean}}} p
 */
function planAudio({ input, probe, opts }) {
  const fmt = F.AUDIO_FORMATS[opts.format];
  if (!fmt) throw new PlanError('فرمت خروجی نامعتبر است.');
  const audios = M.streamsOf(probe, 'audio');
  if (!audios.length) throw new PlanError('این فایل هیچ صدایی ندارد.');
  const a = audios.find((s) => s.disposition && s.disposition.default) || audios[0];
  const duration = M.durationOf(probe);
  let sampleRate = Number(opts.sampleRate) || 0;
  // loudnorm resamples to 192 kHz internally, so pin the output rate.
  if (opts.normalize && !sampleRate) sampleRate = Math.min(Number(a.sample_rate) || 48000, 48000);
  const enc = audioEncoderArgs(fmt.codec, {
    kbps: Number(opts.kbps) || fmt.defaultKbps,
    srcChannels: Number(a.channels) || 2,
    channels: Number(opts.channels) || 0,
    sampleRate,
  });
  const build = (output) => {
    const args = [...HEAD, '-i', input, '-map', `0:${a.index}`, '-vn', '-sn', '-dn'];
    if (opts.normalize) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    args.push(...enc, '-map_metadata', '0', ...(fmt.flags || []), ...tail(output));
    return [{ args, weight: 1 }];
  };
  return {
    ext: fmt.ext,
    suffix: fmt.suffix,
    duration,
    info: { codec: F.AUDIO_CODECS[fmt.codec].encoder, sourceCodec: a.codec_name },
    build,
  };
}

/* -------------------------------------------------------------------- editor */

function rotateFilters(rotate) {
  switch (Number(rotate) || 0) {
    case 90: return ['transpose=1'];
    case 180: return ['hflip', 'vflip'];
    case 270: return ['transpose=2'];
    default: return [];
  }
}

/**
 * @param {{input:string, probe:object, opts:{
 *   start?:number, end?:number, cutMode?:'keep'|'remove', precise?:boolean,
 *   crop?:string, rotate?:number, flip?:'none'|'h'|'v', mute?:boolean, format?:string,
 *   compress?:{mode:'none'|'smart'|'ratio'|'size', ratio?:number, sizeMB?:number,
 *              codec?:string, resolution?:'auto'|'original'|number}}}} p
 */
function planEdit({ input, probe, opts = {} }) {
  const v = M.pickVideoStream(probe);
  if (!v) throw new PlanError('این فایل تصویر ویدیویی ندارد.');
  const total = M.durationOf(probe);
  if (!total) throw new PlanError('مدت زمان ویدیو قابل تشخیص نیست.');
  const audios = M.streamsOf(probe, 'audio');
  const mute = !!opts.mute || audios.length === 0;
  const compress = Object.assign({ mode: 'none', resolution: 'original' }, opts.compress || {});

  // ---- time range
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const S = clamp(Number.isFinite(+opts.start) ? +opts.start : 0, 0, total);
  const E = clamp(Number.isFinite(+opts.end) && +opts.end > 0 ? +opts.end : total, 0, total);
  if (E - S < 0.1) throw new PlanError('بازه‌ی انتخاب‌شده خیلی کوتاه است (حداقل ۰٫۱ ثانیه).');
  let segments;
  if (opts.cutMode === 'remove') {
    segments = [];
    if (S > 0.05) segments.push([0, S]);
    if (E < total - 0.05) segments.push([E, total]);
    if (!segments.length) throw new PlanError('نمی‌توان کل ویدیو را حذف کرد.');
  } else segments = [[S, E]];
  const outDur = segments.reduce((acc, [a, b]) => acc + (b - a), 0);
  const isTrimmed = !(segments.length === 1 && segments[0][0] < 0.001 && segments[0][1] > total - 0.001);

  // ---- geometry
  const src = M.displayDims(v) || { w: 0, h: 0 };
  let dims = { ...src };
  const vf = [];
  const aspect = F.ASPECTS[opts.crop];
  if (aspect && dims.w) {
    const r = M.cropForAspect(dims.w, dims.h, aspect[0], aspect[1]);
    if (r) {
      vf.push(`crop=${r.w}:${r.h}:${r.x}:${r.y}`);
      dims = { w: r.w, h: r.h };
    }
  }
  const rot = rotateFilters(opts.rotate);
  if (rot.length) {
    vf.push(...rot);
    if (Number(opts.rotate) === 90 || Number(opts.rotate) === 270) dims = { w: dims.h, h: dims.w };
  }
  if (opts.flip === 'h') vf.push('hflip');
  if (opts.flip === 'v') vf.push('vflip');

  const needsEncode = vf.length > 0 || compress.mode !== 'none' || (compress.resolution && compress.resolution !== 'original' && compress.resolution !== 'auto');
  if (!needsEncode && !isTrimmed && !opts.mute) throw new PlanError('هیچ تغییری انتخاب نشده است.');
  const copy = !needsEncode && segments.length === 1 && !opts.precise;

  if (copy) {
    const srcExt = (input.split('.').pop() || '').toLowerCase();
    const ext = COPY_SAFE_EXT.has(srcExt) ? srcExt : 'mkv';
    const [a0, b0] = segments[0];
    return {
      ext,
      duration: outDur,
      info: { mode: 'copy', width: src.w, height: src.h, duration: outDur, codec: v.codec_name, targetBytes: null },
      build: (output) => {
        const args = [...HEAD];
        if (a0 > 0) args.push('-ss', t3(a0));
        args.push('-i', input, '-t', t3(b0 - a0), '-map', '0:v', '-map', '0:s?');
        if (!opts.mute) args.push('-map', '0:a?');
        if (ext === 'mkv') args.push('-map', '0:t?');
        args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', '-map_metadata', '0');
        if (MP4_LIKE.has(ext)) args.push('-movflags', '+faststart');
        args.push(...tail(output));
        return [{ args, weight: 1 }];
      },
    };
  }

  // ---- encode path
  const fmt = F.EDITOR_FORMATS[opts.format] || F.EDITOR_FORMATS.mp4;
  const codecKey = fmt.codecs.includes(compress.codec) ? compress.codec : fmt.codecs[0];
  const codec = F.VIDEO_CODECS[codecKey];
  const fps = M.parseRate(v.avg_frame_rate || v.r_frame_rate) || 30;
  let enc;
  let audioKbps = 192;
  let targetBytes = null;
  if (compress.mode === 'ratio' || compress.mode === 'size') {
    const srcBytes = M.num(probe.format && probe.format.size);
    const segBytes = srcBytes * (outDur / total);
    if (compress.mode === 'ratio') {
      const ratio = Number(compress.ratio);
      if (!(ratio > 0 && ratio < 1)) throw new PlanError('نسبت کاهش حجم نامعتبر است.');
      if (!srcBytes) throw new PlanError('حجم فایل اصلی قابل تشخیص نیست؛ از حالت «حجم دلخواه» استفاده کنید.');
      targetBytes = segBytes * ratio;
    } else {
      const mb = Number(compress.sizeMB);
      if (!(mb > 0)) throw new PlanError('حجم دلخواه را به مگابایت وارد کنید.');
      targetBytes = mb * 1024 * 1024;
      if (srcBytes && targetBytes >= segBytes) throw new PlanError('حجم دلخواه از حجم فعلی ویدیو بیشتر است؛ عدد کوچک‌تری وارد کنید.');
    }
    const bp = M.planBitrate({ targetBytes, duration: outDur, hasAudio: !mute });
    if (!bp.ok) throw new PlanError('حجم هدف برای این مدت زمان خیلی کم است؛ حجم بیشتری انتخاب کنید یا ویدیو را کوتاه‌تر کنید.');
    audioKbps = bp.audioKbps;
    enc = { kbps: bp.videoKbps, speed: 'balanced', twoPass: true };
  } else if (compress.mode === 'smart') {
    enc = { quality: 'medium', speed: codecKey === 'h264' ? 'best' : 'balanced' };
    audioKbps = 128;
  } else {
    enc = { quality: 'high', speed: 'balanced' };
  }

  // resolution
  let scale = null;
  const res = compress.resolution;
  if (Number(res) > 0) scale = M.scaleToShortSide(dims.w, dims.h, Number(res));
  else if (res === 'auto' && enc.kbps && codec.bppFloor) {
    scale = M.autoResolution({ w: dims.w, h: dims.h, fps, videoKbps: enc.kbps, bppFloor: codec.bppFloor });
  }
  if (scale) {
    vf.push(`scale=${scale.w}:${scale.h}:flags=lanczos`);
    dims = scale;
  } else {
    const fix = evenFix(dims);
    if (fix) {
      vf.push(`scale=${fix.w}:${fix.h}`);
      dims = fix;
    }
  }

  const aIdx = mute ? [] : audios.map((s) => s.index);
  const chain = vf.length ? vf.join(',') : 'null';

  /** Build -filter_complex graph + maps for either one seeked segment or several concatenated ones. */
  const graphFor = (withAudio) => {
    const vin = `[0:${v.index}]`;
    if (segments.length === 1) {
      const maps = ['-map', '[vout]'];
      if (withAudio) aIdx.forEach((i) => maps.push('-map', `0:${i}`));
      return { graph: `${vin}${chain}[vout]`, maps, audioTracks: withAudio ? aIdx.length : 0 };
    }
    const n = segments.length;
    const ain = withAudio && aIdx.length ? `[0:${aIdx[0]}]` : null;
    const parts = [`${vin}split=${n}${segments.map((_, i) => `[vi${i}]`).join('')}`];
    if (ain) parts.push(`${ain}asplit=${n}${segments.map((_, i) => `[ai${i}]`).join('')}`);
    let concatIn = '';
    segments.forEach(([a, b], i) => {
      const range = `start=${t3(a)}${b < total - 0.001 ? `:end=${t3(b)}` : ''}`;
      parts.push(`[vi${i}]trim=${range},setpts=PTS-STARTPTS[vs${i}]`);
      if (ain) parts.push(`[ai${i}]atrim=${range},asetpts=PTS-STARTPTS[as${i}]`);
      concatIn += `[vs${i}]${ain ? `[as${i}]` : ''}`;
    });
    parts.push(`${concatIn}concat=n=${n}:v=1:a=${ain ? 1 : 0}[vc]${ain ? '[ac]' : ''}`);
    parts.push(`[vc]${chain}[vout]`);
    const maps = ['-map', '[vout]'];
    if (ain) maps.push('-map', '[ac]');
    return { graph: parts.join(';'), maps, audioTracks: ain ? 1 : 0 };
  };

  const inputArgs = () => {
    const a = [];
    if (segments.length === 1) {
      const [a0, b0] = segments[0];
      if (a0 > 0) a.push('-ss', t3(a0));
      a.push('-t', t3(b0 - a0));
    }
    return a.concat(['-i', input]);
  };

  const g = graphFor(!mute);
  const build = (output) => {
    const passes = [];
    const common = [...HEAD, ...inputArgs()];
    if (enc.twoPass) {
      // Multi-segment graphs must be identical in both passes (concat timing depends on
      // the audio branch), so pass 1 keeps the audio and discards it as cheap PCM.
      const sameGraph = segments.length > 1 && g.audioTracks > 0;
      const g1 = sameGraph ? g : graphFor(false);
      passes.push({
        args: [...common, '-filter_complex', g1.graph, ...g1.maps,
          ...videoEncoderArgs(codecKey, { kbps: enc.kbps, speed: enc.speed, pass: 1, container: fmt.ext }),
          ...PASS_TB, ...(sameGraph ? ['-c:a', 'pcm_s16le'] : ['-an']), '-sn', '-f', 'null', ...tail('-')],
        weight: 0.4,
      });
    }
    const a = [...common, '-filter_complex', g.graph, ...g.maps,
      ...videoEncoderArgs(codecKey, { quality: enc.quality, kbps: enc.kbps, speed: enc.speed, pass: enc.twoPass ? 2 : undefined, container: fmt.ext }),
      ...(enc.twoPass ? PASS_TB : [])];
    if (g.audioTracks) {
      const ch = Math.max(...audios.map((s) => Number(s.channels) || 2));
      a.push(...audioEncoderArgs(fmt.audio, { kbps: fmt.audio === 'opus' ? Math.min(audioKbps, 160) : audioKbps, srcChannels: ch }));
    } else a.push('-an');
    a.push('-sn', '-map_metadata', '0', '-max_muxing_queue_size', '9999', ...(fmt.flags || []), ...tail(output));
    passes.push({ args: a, weight: enc.twoPass ? 0.6 : 1 });
    return passes;
  };

  return {
    ext: fmt.ext,
    duration: outDur,
    info: {
      mode: 'encode',
      codec: codecKey,
      width: dims.w,
      height: dims.h,
      duration: outDur,
      targetBytes: targetBytes ? Math.round(targetBytes) : null,
      videoKbps: enc.kbps || null,
      audioKbps: g.audioTracks ? audioKbps : 0,
      twoPass: !!enc.twoPass,
    },
    build,
  };
}

/* ------------------------------------------------------------------ screen recording */

/**
 * Finalises a raw MediaRecorder capture (webm/mp4, often without duration/index and with
 * odd-sized frames) into a well-formed, seekable file — MP4 by default.
 * opts: { duration?: seconds hint, crop?: {x,y,w,h[,unit:'ratio']}, quality?: 'high'|'medium', container?: 'mp4'|'webm' }
 */
function planRecord({ input, probe, opts = {} }) {
  const v = M.pickVideoStream(probe);
  if (!v) throw new PlanError('ضبط انجام نشد: تصویری در فایل ضبط‌شده وجود ندارد.');
  const duration = M.durationOf(probe) || Math.max(0, Number(opts.duration) || 0);
  const src = M.displayDims(v) || { w: 0, h: 0 };
  const vf = [];
  let dims = { ...src };
  let c = opts.crop;
  // crop may be given as ratios of the frame (UI selections) or in source pixels
  if (c && c.unit === 'ratio') c = { x: c.x * src.w, y: c.y * src.h, w: c.w * src.w, h: c.h * src.h };
  if (c && src.w && src.h) {
    // clamp to the frame and keep everything even (4:2:0)
    const ev = (n) => Math.max(0, Math.round(n / 2) * 2);
    const evf = (n) => Math.max(0, Math.floor(n / 2) * 2);
    const x = ev(Math.min(Math.max(0, +c.x || 0), src.w - 16));
    const y = ev(Math.min(Math.max(0, +c.y || 0), src.h - 16));
    const w = Math.max(16, evf(Math.min(Math.round(+c.w) || src.w, src.w - x)));
    const h = Math.max(16, evf(Math.min(Math.round(+c.h) || src.h, src.h - y)));
    if (w < src.w - 1 || h < src.h - 1) {
      vf.push(`crop=${w}:${h}:${x}:${y}`);
      dims = { w, h };
    }
  }
  if (!vf.length) {
    const fix = evenFix(dims);
    if (fix) {
      vf.push(`scale=${fix.w}:${fix.h}`);
      dims = fix;
    }
  }
  const audios = M.streamsOf(probe, 'audio').slice(0, 1);
  const info = (mode) => ({ mode, width: dims.w, height: dims.h, duration, audio: audios.length > 0 });

  // WEBM capture kept as WEBM (web build): lossless remux that adds duration + seek index
  const webm = opts.container === 'webm' && !vf.length && ['vp8', 'vp9', 'av1'].includes(v.codec_name)
    && audios.every((a) => ['opus', 'vorbis'].includes(a.codec_name));
  if (webm) {
    return {
      ext: 'webm',
      duration,
      suffix: 'recording',
      info: info('copy'),
      build: (output) => [{
        args: [...HEAD, '-fflags', '+genpts', '-i', input, '-map', `0:${v.index}`, ...(audios.length ? ['-map', `0:${audios[0].index}`] : []),
          '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...tail(output)],
        weight: 1,
      }],
    };
  }

  const copyV = !vf.length && v.codec_name === 'h264';
  const copyA = audios.length > 0 && audios[0].codec_name === 'aac';
  const crf = opts.quality === 'medium' ? 26 : 20;
  const build = (output) => {
    const a = [...HEAD, '-fflags', '+genpts', '-i', input, '-map', `0:${v.index}`];
    if (audios.length) a.push('-map', `0:${audios[0].index}`);
    if (copyV) a.push('-c:v', 'copy');
    else {
      if (vf.length) a.push('-vf', vf.join(','));
      a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr');
    }
    if (audios.length) {
      if (copyA) a.push('-c:a', 'copy');
      else a.push(...audioEncoderArgs('aac', { kbps: 192, srcChannels: Number(audios[0].channels) || 2 }));
    } else a.push('-an');
    a.push('-sn', '-dn', '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '9999', '-movflags', '+faststart', ...tail(output));
    return [{ args: a, weight: 1 }];
  };
  return { ext: 'mp4', duration, suffix: 'recording', info: info(copyV ? 'copy' : 'encode'), build };
}

module.exports = { PlanError, planVideo, planAudio, planEdit, planRecord, videoEncoderArgs, audioEncoderArgs, planSubtitles };
