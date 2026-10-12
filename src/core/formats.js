'use strict';
/**
 * Single source of truth for every supported container / codec.
 * The main process plans ffmpeg arguments from it and the renderer receives
 * a serialisable catalog, so the UI can never offer something the engine can't do.
 */

/** Video encoders. `quality` maps high/medium/low to each encoder's native scale. */
const VIDEO_CODECS = {
  h264: { label: 'H.264 (AVC)', encoder: 'libx264', family: 'x264', quality: { high: 18, medium: 23, low: 28 }, bppFloor: 0.05 },
  h265: { label: 'H.265 (HEVC)', encoder: 'libx265', family: 'x265', quality: { high: 22, medium: 26, low: 30 }, bppFloor: 0.035 },
  vp9: { label: 'VP9', encoder: 'libvpx-vp9', family: 'vp9', quality: { high: 24, medium: 32, low: 40 }, bppFloor: 0.04 },
  vp8: { label: 'VP8', encoder: 'libvpx', family: 'vp8', quality: { high: 6, medium: 10, low: 20 }, bppFloor: 0.05 },
  mpeg4: { label: 'MPEG-4 (Xvid)', encoder: 'mpeg4', family: 'qscale', quality: { high: 2, medium: 4, low: 7 }, extra: ['-vtag', 'XVID'] },
  wmv2: { label: 'WMV 8', encoder: 'wmv2', family: 'qscale', quality: { high: 2, medium: 4, low: 7 } },
  mpeg2: { label: 'MPEG-2', encoder: 'mpeg2video', family: 'qscale', quality: { high: 2, medium: 4, low: 7 } },
  theora: { label: 'Theora', encoder: 'libtheora', family: 'theora', quality: { high: 9, medium: 7, low: 5 } },
};

/** Audio encoders used inside video containers and by the audio converter. */
const AUDIO_CODECS = {
  aac: { encoder: 'aac' },
  mp3: { encoder: 'libmp3lame', maxChannels: 2 },
  opus: { encoder: 'libopus', maxChannels: 2, rates: [48000, 24000, 16000, 12000, 8000] },
  vorbis: { encoder: 'libvorbis' },
  wma: { encoder: 'wmav2', maxChannels: 2, maxKbps: 192 },
  mp2: { encoder: 'mp2', maxChannels: 2 },
  ac3: { encoder: 'ac3' },
  flac: { encoder: 'flac', lossless: true },
  alac: { encoder: 'alac', lossless: true },
  pcm16le: { encoder: 'pcm_s16le', lossless: true },
  pcm16be: { encoder: 'pcm_s16be', lossless: true },
  amr: { encoder: 'libopencore_amrnb', fixed: true },
};

/** Audio bitrate (kbps) used inside converted video files per quality level. */
const VIDEO_AUDIO_KBPS = { high: 192, medium: 160, low: 128 };

const ANY = '*';

/**
 * Video containers.
 * copyV / copyA : source codecs that can be stream-copied (no quality loss).
 * subs          : how subtitles are carried ('copy' | 'mov_text' | 'webvtt' | null).
 * multiAudio    : container reliably supports several audio tracks.
 */
const VIDEO_FORMATS = {
  mp4: { label: 'MP4', ext: 'mp4', codecs: ['h264', 'h265'], audio: 'aac', copyV: ['h264', 'hevc', 'mpeg4', 'av1'], copyA: ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac', 'flac'], subs: 'mov_text', multiAudio: true, flags: ['-movflags', '+faststart'] },
  mkv: { label: 'MKV', ext: 'mkv', codecs: ['h264', 'h265'], audio: 'aac', copyV: ANY, copyA: ANY, subs: 'copy', multiAudio: true },
  avi: { label: 'AVI', ext: 'avi', codecs: ['mpeg4'], audio: 'mp3', copyV: ['mpeg4', 'h264', 'mjpeg', 'msmpeg4v3'], copyA: ['mp3', 'ac3', 'mp2', 'pcm_s16le'], subs: null, multiAudio: true },
  mov: { label: 'MOV', ext: 'mov', codecs: ['h264', 'h265'], audio: 'aac', copyV: ['h264', 'hevc', 'mpeg4', 'prores', 'mjpeg'], copyA: ['aac', 'mp3', 'alac', 'ac3', 'pcm_s16le', 'pcm_s24le'], subs: 'mov_text', multiAudio: true, flags: ['-movflags', '+faststart'] },
  wmv: { label: 'WMV', ext: 'wmv', codecs: ['wmv2'], audio: 'wma', copyV: ['wmv1', 'wmv2', 'wmv3', 'vc1'], copyA: ['wmav1', 'wmav2', 'wmapro'], subs: null, multiAudio: false },
  webm: { label: 'WEBM', ext: 'webm', codecs: ['vp9', 'vp8'], audio: 'opus', copyV: ['vp8', 'vp9', 'av1'], copyA: ['opus', 'vorbis'], subs: 'webvtt', multiAudio: true },
  flv: { label: 'FLV', ext: 'flv', codecs: ['h264'], audio: 'aac', copyV: ['h264'], copyA: ['aac', 'mp3'], subs: null, multiAudio: false },
  mpg: { label: 'MPEG', ext: 'mpg', codecs: ['mpeg2'], audio: 'mp2', copyV: ['mpeg1video', 'mpeg2video'], copyA: ['mp2', 'mp3', 'ac3'], subs: null, multiAudio: true, flags: ['-f', 'vob'] },
  ts: { label: 'TS', ext: 'ts', codecs: ['h264', 'h265'], audio: 'aac', copyV: ['h264', 'hevc', 'mpeg2video'], copyA: ['aac', 'mp3', 'ac3', 'eac3', 'mp2'], subs: null, multiAudio: true },
  m4v: { label: 'M4V', ext: 'm4v', codecs: ['h264'], audio: 'aac', copyV: ['h264'], copyA: ['aac', 'ac3'], subs: 'mov_text', multiAudio: true, flags: ['-f', 'mp4', '-movflags', '+faststart'] },
  '3gp': { label: '3GP', ext: '3gp', codecs: ['h264'], audio: 'aac', copyV: ['h264', 'h263', 'mpeg4'], copyA: ['aac', 'amr_nb'], subs: null, multiAudio: false },
  ogv: { label: 'OGV', ext: 'ogv', codecs: ['theora'], audio: 'vorbis', copyV: ['theora', 'vp8'], copyA: ['vorbis', 'opus', 'flac'], subs: null, multiAudio: true },
  gif: { label: 'GIF', ext: 'gif', codecs: [], audio: null, gif: true },
};

/** Formats offered by the audio converter. */
const AUDIO_FORMATS = {
  mp3: { label: 'MP3', ext: 'mp3', codec: 'mp3', defaultKbps: 192 },
  m4a: { label: 'M4A', ext: 'm4a', codec: 'aac', defaultKbps: 192, flags: ['-movflags', '+faststart'] },
  aac: { label: 'AAC', ext: 'aac', codec: 'aac', defaultKbps: 192 },
  wav: { label: 'WAV', ext: 'wav', codec: 'pcm16le' },
  flac: { label: 'FLAC', ext: 'flac', codec: 'flac' },
  ogg: { label: 'OGG', ext: 'ogg', codec: 'vorbis', defaultKbps: 192 },
  opus: { label: 'OPUS', ext: 'opus', codec: 'opus', defaultKbps: 128 },
  wma: { label: 'WMA', ext: 'wma', codec: 'wma', defaultKbps: 192 },
  aiff: { label: 'AIFF', ext: 'aiff', codec: 'pcm16be' },
  ac3: { label: 'AC3', ext: 'ac3', codec: 'ac3', defaultKbps: 192 },
  alac: { label: 'ALAC', ext: 'm4a', codec: 'alac', suffix: 'alac' },
  amr: { label: 'AMR', ext: 'amr', codec: 'amr' },
};

/** Containers the editor writes when it has to re-encode. */
const EDITOR_FORMATS = {
  mp4: { label: 'MP4', ext: 'mp4', codecs: ['h264', 'h265'], audio: 'aac', flags: ['-movflags', '+faststart'] },
  mkv: { label: 'MKV', ext: 'mkv', codecs: ['h264', 'h265'], audio: 'aac' },
  mov: { label: 'MOV', ext: 'mov', codecs: ['h264', 'h265'], audio: 'aac', flags: ['-movflags', '+faststart'] },
  webm: { label: 'WEBM', ext: 'webm', codecs: ['vp9', 'vp8'], audio: 'opus' },
};

const RESOLUTIONS = [2160, 1440, 1080, 720, 480, 360];
const AUDIO_BITRATES = [320, 256, 192, 160, 128, 96, 64];
const SAMPLE_RATES = [48000, 44100, 32000, 22050, 16000];
const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:3': [4, 3], '3:4': [3, 4], '4:5': [4, 5], '21:9': [21, 9] };

const VIDEO_INPUT_EXT = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'mpg', 'mpeg', 'm4v', '3gp', '3g2', 'ts', 'mts', 'm2ts', 'ogv', 'vob', 'gif', 'f4v', 'asf', 'rm', 'rmvb', 'divx', 'mxf', 'dv', 'y4m'];
const AUDIO_INPUT_EXT = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'ac3', 'eac3', 'amr', 'ape', 'wv', 'mka', 'mp2', 'dts', 'm4b', 'caf', 'au', 'tta'];

/**
 * Limit the tables to what the current engine can encode (e.g. the browser build has no AMR
 * encoder and its VP9 encoder is unstable). Mutates in place so planners and catalog agree.
 * @param {Iterable<string>} encoders available encoder names
 * @param {object} [audioSwaps] per-codec overrides applied first (encoder name / extra args)
 */
function restrict(encoders, audioSwaps = {}) {
  const has = new Set(encoders);
  // Engine-specific encoder substitutions, e.g. { opus: { encoder: 'opus', extra: ['-strict', '-2'] } }
  for (const [k, patch] of Object.entries(audioSwaps)) if (AUDIO_CODECS[k]) Object.assign(AUDIO_CODECS[k], patch);
  for (const tbl of [VIDEO_FORMATS, EDITOR_FORMATS]) {
    for (const [k, f] of Object.entries(tbl)) {
      if (f.gif) {
        if (!has.has('gif')) delete tbl[k];
        continue;
      }
      f.codecs = f.codecs.filter((c) => has.has(VIDEO_CODECS[c].encoder));
      if (!f.codecs.length || (f.audio && !has.has(AUDIO_CODECS[f.audio].encoder))) delete tbl[k];
    }
  }
  for (const [k, f] of Object.entries(AUDIO_FORMATS)) if (!has.has(AUDIO_CODECS[f.codec].encoder)) delete AUDIO_FORMATS[k];
}

/** Plain, serialisable catalog for the renderer. */
function catalog() {
  const map = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
  return {
    videoFormats: map(VIDEO_FORMATS, (f) => ({ label: f.label, ext: f.ext, codecs: f.codecs, gif: !!f.gif })),
    audioFormats: map(AUDIO_FORMATS, (f) => ({
      label: f.label,
      ext: f.ext,
      lossless: !!AUDIO_CODECS[f.codec].lossless,
      fixed: !!AUDIO_CODECS[f.codec].fixed,
      defaultKbps: f.defaultKbps || null,
    })),
    editorFormats: map(EDITOR_FORMATS, (f) => ({ label: f.label, ext: f.ext, codecs: f.codecs })),
    videoCodecs: map(VIDEO_CODECS, (c) => ({ label: c.label })),
    resolutions: RESOLUTIONS,
    audioBitrates: AUDIO_BITRATES,
    sampleRates: SAMPLE_RATES,
    aspects: Object.keys(ASPECTS),
    videoInputExt: VIDEO_INPUT_EXT,
    audioInputExt: AUDIO_INPUT_EXT,
  };
}

module.exports = {
  ANY, VIDEO_CODECS, AUDIO_CODECS, VIDEO_FORMATS, AUDIO_FORMATS, EDITOR_FORMATS,
  VIDEO_AUDIO_KBPS, RESOLUTIONS, AUDIO_BITRATES, SAMPLE_RATES, ASPECTS,
  VIDEO_INPUT_EXT, AUDIO_INPUT_EXT, catalog, restrict,
};
