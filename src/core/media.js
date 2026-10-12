'use strict';
/** Pure helpers that interpret ffprobe JSON and do geometry / bitrate math. */

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Round to nearest even integer (encoders need even dimensions), min 2. */
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const floorEven = (x) => Math.max(2, Math.floor(x / 2) * 2);

function parseRate(r) {
  if (!r || typeof r !== 'string') return 0;
  const [a, b] = r.split('/').map(Number);
  if (!b) return num(a);
  return a / b;
}

function rotationOf(stream) {
  if (!stream) return 0;
  const sd = (stream.side_data_list || []).find((d) => d.rotation !== undefined);
  let rot = sd ? num(sd.rotation) : num(stream.tags && stream.tags.rotate);
  rot = ((Math.round(rot) % 360) + 360) % 360;
  return rot;
}

function streamsOf(probe, type) {
  return ((probe && probe.streams) || []).filter((s) => s.codec_type === type);
}

/** First real video stream (skips embedded cover art). */
function pickVideoStream(probe) {
  return streamsOf(probe, 'video').find((s) => !(s.disposition && s.disposition.attached_pic)) || null;
}

function durationOf(probe) {
  let d = num(probe && probe.format && probe.format.duration);
  if (!d) {
    for (const s of (probe && probe.streams) || []) d = Math.max(d, num(s.duration));
  }
  return d;
}

/** Width/height as displayed (after rotation metadata is applied by the decoder). */
function displayDims(stream) {
  if (!stream) return null;
  const w = num(stream.width);
  const h = num(stream.height);
  if (!w || !h) return null;
  const rot = rotationOf(stream);
  return rot === 90 || rot === 270 ? { w: h, h: w } : { w, h };
}

/** Compact summary sent to the UI. */
function summarize(probe, filePath, size) {
  const v = pickVideoStream(probe);
  const audio = streamsOf(probe, 'audio');
  const a = audio[0];
  const dims = displayDims(v);
  return {
    path: filePath,
    size: num(size || (probe.format && probe.format.size)),
    duration: durationOf(probe),
    bitrate: num(probe.format && probe.format.bit_rate),
    container: (probe.format && probe.format.format_name) || '',
    hasVideo: !!v,
    hasAudio: !!a,
    width: dims ? dims.w : 0,
    height: dims ? dims.h : 0,
    fps: v ? Math.round(parseRate(v.avg_frame_rate || v.r_frame_rate) * 100) / 100 : 0,
    vcodec: v ? v.codec_name : '',
    acodec: a ? a.codec_name : '',
    audioTracks: audio.length,
    channels: a ? num(a.channels) : 0,
    sampleRate: a ? num(a.sample_rate) : 0,
    subtitleTracks: streamsOf(probe, 'subtitle').length,
  };
}

/**
 * Downscale so the *short* side equals `target` (works for portrait and landscape).
 * Returns null when no downscale is needed (never upscales).
 */
function scaleToShortSide(w, h, target) {
  if (!target || !w || !h) return null;
  if (Math.min(w, h) <= target) return null;
  return w >= h ? { w: even((w * target) / h), h: even(target) } : { w: even(target), h: even((h * target) / w) };
}

/** Centered crop rectangle for an aspect ratio. Returns null if already matching. */
function cropForAspect(w, h, aw, ah) {
  const target = aw / ah;
  let cw;
  let ch;
  if (w / h > target) {
    ch = floorEven(h);
    cw = floorEven(h * target);
  } else {
    cw = floorEven(w);
    ch = floorEven(w / target);
  }
  if (Math.abs(cw - w) <= 2 && Math.abs(ch - h) <= 2) return null;
  return { w: cw, h: ch, x: Math.floor((w - cw) / 2), y: Math.floor((h - ch) / 2) };
}

/**
 * Bitrate plan for hitting a target file size.
 * Returns kbps for video and audio; `ok:false` when the target is unrealistically small.
 */
function planBitrate({ targetBytes, duration, hasAudio }) {
  const totalKbps = (targetBytes * 8) / 1000 / Math.max(duration, 0.1);
  let audioKbps = 0;
  if (hasAudio) {
    if (totalKbps >= 1500) audioKbps = 128;
    else if (totalKbps >= 600) audioKbps = 96;
    else if (totalKbps >= 250) audioKbps = 64;
    else audioKbps = 48;
  }
  const videoKbps = Math.floor(totalKbps * 0.975 - audioKbps); // ~2.5% container overhead
  return { totalKbps, audioKbps, videoKbps, ok: videoKbps >= 40 };
}

/** Pick a resolution so that bits-per-pixel stays above the codec's floor. */
function autoResolution({ w, h, fps, videoKbps, bppFloor }) {
  const steps = [1080, 720, 540, 480, 360];
  const f = fps > 0 ? Math.min(fps, 60) : 30;
  let dims = { w, h };
  const bpp = (d) => (videoKbps * 1000) / (d.w * d.h * f);
  if (bpp(dims) >= bppFloor) return null;
  for (const s of steps) {
    const next = scaleToShortSide(w, h, s);
    if (!next) continue;
    dims = next;
    if (bpp(dims) >= bppFloor) break;
  }
  return dims.w === w && dims.h === h ? null : dims;
}

/** "1:02:03.5" | "62.5" | "۱:۲۰" -> seconds. Returns NaN on garbage. */
function parseTime(input) {
  if (typeof input === 'number') return input;
  if (input == null) return NaN;
  const s = String(input)
    .trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[٫,]/g, '.');
  if (!s) return NaN;
  if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(s)) return NaN;
  return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** seconds -> "HH:MM:SS.mmm" */
function formatTime(sec, withMs = true) {
  const t = Math.max(0, num(sec));
  const totalMs = Math.round(t * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}${withMs ? '.' + p(ms, 3) : ''}`;
}

module.exports = {
  TEXT_SUBS, num, even, floorEven, parseRate, rotationOf, streamsOf, pickVideoStream,
  durationOf, displayDims, summarize, scaleToShortSide, cropForAspect, planBitrate,
  autoResolution, parseTime, formatTime,
};
