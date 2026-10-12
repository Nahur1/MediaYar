'use strict';
(() => {
  const q = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  const px = { w: Number(q.get('w')) || screen.width, h: Number(q.get('h')) || screen.height };
  const ov = document.getElementById('ov');
  const bar = document.getElementById('bar');
  const hint = document.getElementById('hint');
  function placeBar(r) {
    if (!r) return;
    const below = r.y + r.h < 0.88;
    bar.style.top = below ? `calc(${(r.y + r.h) * 100}% + 12px)` : '';
    bar.style.bottom = below ? '' : `calc(${(1 - r.y) * 100}% + 12px)`;
    if (!below && r.y < 0.1) { bar.style.bottom = ''; bar.style.top = `calc(${(r.y + r.h / 2) * 100}% - 22px)`; }
    bar.style.left = `${Math.min(Math.max((r.x + r.w / 2) * 100, 15), 85)}%`;
  }
  const sel = RegionSelect.attach(ov, {
    pixels: () => px,
    onChange: (r) => { bar.hidden = !r; hint.hidden = !!r; placeBar(r); },
  });
  const done = (r) => window.aux.region(r);
  document.getElementById('ok').addEventListener('click', () => sel.value && done(sel.value));
  document.getElementById('full').addEventListener('click', () => done({ x: 0, y: 0, w: 1, h: 1 }));
  document.getElementById('cancel').addEventListener('click', () => done(null));
  ov.addEventListener('dblclick', (e) => { if (sel.value && e.target.closest('.rs-box')) done(sel.value); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') done(null);
    if (e.key === 'Enter' && sel.value) done(sel.value);
  });
  if (q.get('focus') === '1') window.focus();
})();
