'use strict';
/**
 * Mouse/touch rectangle selector used by the desktop full-screen overlay and the web
 * "select region on preview" dialog. Works in ratios (0..1) of the host element so the
 * result maps onto any capture resolution; ffmpeg does the actual crop.
 */
window.RegionSelect = {
  attach(root, { onChange, pixels = () => ({ w: root.clientWidth, h: root.clientHeight }), initial = null } = {}) {
    const MIN = 0.02;
    const box = document.createElement('div');
    box.className = 'rs-box';
    box.hidden = true;
    const size = document.createElement('div');
    size.className = 'rs-size';
    size.dir = 'ltr';
    box.append(size);
    for (const hnd of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const el = document.createElement('span');
      el.className = `rs-h ${hnd}`;
      el.dataset.h = hnd;
      box.append(el);
    }
    root.classList.add('rs-host');
    root.append(box);
    let r = null;
    let drag = null;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    function paint() {
      root.classList.toggle('rs-has', !!r);
      box.hidden = !r;
      if (!r) return;
      Object.assign(box.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
      const p = pixels();
      size.textContent = `${Math.round((r.w * p.w) / 2) * 2} × ${Math.round((r.h * p.h) / 2) * 2}`;
      size.classList.toggle('inside', r.y < 0.06);
    }
    const emit = () => onChange && onChange(r ? { ...r } : null);
    const pt = (e) => {
      const b = root.getBoundingClientRect();
      return { x: clamp((e.clientX - b.left) / b.width, 0, 1), y: clamp((e.clientY - b.top) / b.height, 0, 1) };
    };

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('[data-rs-ignore]')) return;
      e.preventDefault();
      const p = pt(e);
      const handle = e.target.dataset && e.target.dataset.h;
      if (handle && r) drag = { mode: 'resize', handle, start: p, orig: { ...r } };
      else if (r && e.target.closest('.rs-box')) drag = { mode: 'move', start: p, orig: { ...r } };
      else drag = { mode: 'new', start: p };
      root.setPointerCapture(e.pointerId);
    });
    root.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = pt(e);
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      const o = drag.orig;
      if (drag.mode === 'new') {
        r = { x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y), w: Math.abs(dx), h: Math.abs(dy) };
      } else if (drag.mode === 'move') {
        r = { ...o, x: clamp(o.x + dx, 0, 1 - o.w), y: clamp(o.y + dy, 0, 1 - o.h) };
      } else {
        let x1 = o.x; let y1 = o.y; let x2 = o.x + o.w; let y2 = o.y + o.h;
        if (drag.handle.includes('w')) x1 = clamp(o.x + dx, 0, x2 - MIN);
        if (drag.handle.includes('e')) x2 = clamp(x2 + dx, x1 + MIN, 1);
        if (drag.handle.includes('n')) y1 = clamp(o.y + dy, 0, y2 - MIN);
        if (drag.handle.includes('s')) y2 = clamp(y2 + dy, y1 + MIN, 1);
        r = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
      paint();
    });
    const end = () => {
      if (!drag) return;
      const wasNew = drag.mode === 'new';
      const prev = drag.orig || null;
      drag = null;
      if (r && (r.w < MIN || r.h < MIN)) r = wasNew ? prev : r;
      paint();
      emit();
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    if (initial) { r = { ...initial }; paint(); }
    return {
      get value() { return r ? { ...r } : null; },
      set(v) { r = v ? { ...v } : null; paint(); emit(); },
      repaint: paint,
    };
  },
};
