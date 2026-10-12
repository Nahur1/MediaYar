'use strict';
/**
 * Filmstrip thumbnails decoded by the browser itself (hardware-accelerated, no ffmpeg calls).
 * Frames are painted straight into <canvas> elements, so nothing is re-encoded.
 */
window.Thumbs = (() => {
  const SEEK_TIMEOUT = 4000;

  function once(el, ok, bad, ms) {
    return new Promise((resolve) => {
      let t = 0;
      const fin = (v) => {
        clearTimeout(t);
        el.removeEventListener(ok, onOk);
        if (bad) el.removeEventListener(bad, onBad);
        resolve(v);
      };
      const onOk = () => fin(true);
      const onBad = () => fin(false);
      el.addEventListener(ok, onOk);
      if (bad) el.addEventListener(bad, onBad);
      t = setTimeout(() => fin(false), ms);
    });
  }

  function paint(canvas, source, sw, sh) {
    const ctx = canvas.getContext('2d', { alpha: false });
    // object-fit: cover
    const cw = canvas.width;
    const ch = canvas.height;
    const s = Math.max(cw / sw, ch / sh);
    const w = sw * s;
    const h = sh * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, (cw - w) / 2, (ch - h) / 2, w, h);
    canvas.dataset.painted = '1';
  }

  /**
   * Fill canvases with frames at `times`. Returns how many were painted (in order);
   * the caller falls back to ffmpeg for the rest (e.g. codecs the browser can't decode).
   */
  async function fill(url, times, canvases, isStale) {
    if (!url) return 0;
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.src = url;
    let n = 0;
    try {
      if (!(await once(v, 'loadeddata', 'error', 6000)) || !v.videoWidth) return 0;
      for (; n < times.length; n++) {
        if (isStale()) return n;
        v.currentTime = Math.min(times[n], Math.max(0, v.duration - 0.05));
        if (!(await once(v, 'seeked', 'error', SEEK_TIMEOUT))) return n;
        paint(canvases[n], v, v.videoWidth, v.videoHeight);
      }
      return n;
    } catch {
      return n;
    } finally {
      v.removeAttribute('src');
      v.load();
    }
  }

  function drawUrl(canvas, src) {
    const img = new Image();
    img.onload = () => paint(canvas, img, img.naturalWidth, img.naturalHeight);
    img.src = src;
  }

  return { fill, drawUrl };
})();
