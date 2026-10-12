'use strict';
/**
 * Incremental parser for ffmpeg's `-progress` key=value stream.
 * Shared by the native runner (stdout pipe) and the web engine (log lines).
 */
function createProgressParser({ duration = 0, onProgress } = {}) {
  let buf = '';
  let state = {};
  function line(raw) {
    const l = raw.trim();
    const eq = l.indexOf('=');
    if (eq < 0) return;
    const key = l.slice(0, eq);
    const val = l.slice(eq + 1);
    state[key] = val;
    if (key !== 'progress') return;
    if (onProgress) {
      const us = Number(state.out_time_us || state.out_time_ms);
      const time = Number.isFinite(us) && us > 0 ? us / 1e6 : 0;
      const speed = parseFloat(state.speed) || 0;
      const ratio = duration > 0 ? Math.min(1, time / duration) : 0;
      onProgress({ ratio: val === 'end' ? 1 : ratio, time, speed });
    }
    state = {};
  }
  return {
    /** Feed a raw chunk (may contain partial lines). */
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    /** Feed one complete line. */
    line,
  };
}

module.exports = { createProgressParser };
