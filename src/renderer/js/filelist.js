'use strict';
/* Drop zone + probed file list shared by the converter pages. */
window.FileList = (() => {
  const { h, icon, fmtBytes, fmtDur } = UI;

  /** Wire a drop zone: click / Enter opens the dialog, drop delivers paths. */
  function bindDrop(zone, kind, onPaths, multi = true) {
    const open = async () => onPaths(await window.api.openFiles(kind, multi));
    zone.addEventListener('click', open);
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    let depth = 0;
    zone.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('over'); } });
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      zone.classList.remove('over');
      const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
      onPaths(multi ? paths : paths.slice(0, 1));
    });
  }

  function metaParts(s) {
    const parts = [];
    if (s.duration) parts.push(fmtDur(s.duration));
    if (s.hasVideo && s.width) parts.push(`${s.width}×${s.height}`);
    if (s.vcodec) parts.push(s.vcodec.toUpperCase());
    if (s.acodec) parts.push(s.acodec.toUpperCase() + (s.channels > 2 ? ` ${s.channels}ch` : ''));
    parts.push(fmtBytes(s.size));
    return parts;
  }

  /**
   * @param {{list:HTMLElement, zone:HTMLElement, kind:'video'|'audio', head:HTMLElement,
   *          count:HTMLElement, clearBtn:HTMLElement, onChange:()=>void}} o
   */
  function create(o) {
    const items = new Map();
    const requirement = o.kind === 'video'
      ? (s) => (s.hasVideo ? null : 'این فایل تصویر ویدیویی ندارد')
      : (s) => (s.hasAudio ? null : 'این فایل صدا ندارد');

    function refresh() {
      const n = items.size;
      o.head.hidden = n === 0;
      o.zone.classList.toggle('compact', n > 0);
      const ready = api.ready.length;
      o.count.textContent = n ? `${ready} فایل آماده${ready !== n ? ` از ${n}` : ''}` : '';
      o.onChange();
    }

    async function addOne(p) {
      if (items.has(p)) return;
      const name = p.split(/[\\/]/).pop();
      const meta = h('div', { class: 'file-meta' });
      const card = h('div', { class: 'file loading' },
        h('div', { class: 'file-icon' }, icon(o.kind === 'video' ? 'film' : 'music')),
        h('div', { class: 'file-body' }, h('div', { class: 'file-name', dir: 'auto', title: p, text: name }), meta),
        h('button', { class: 'remove-btn', type: 'button', 'aria-label': 'حذف', onclick: () => { items.delete(p); card.remove(); refresh(); } }, icon('x')));
      const item = { path: p, name, summary: null, error: null, card };
      items.set(p, item);
      o.list.append(card);
      refresh();
      const r = await window.api.probe(p);
      if (!items.has(p)) return;
      card.classList.remove('loading');
      const err = r.error || requirement(r.summary);
      if (err) {
        item.error = err;
        card.classList.add('error');
        meta.textContent = err;
      } else {
        item.summary = r.summary;
        meta.replaceChildren(...metaParts(r.summary).map((t) => h('span', { text: t })));
      }
      refresh();
    }

    const api = {
      get ready() { return [...items.values()].filter((i) => i.summary); },
      get size() { return items.size; },
      add: (paths) => Promise.all((paths || []).map(addOne)),
      clear() {
        items.clear();
        o.list.replaceChildren();
        refresh();
      },
    };
    bindDrop(o.zone, o.kind, api.add);
    o.clearBtn.addEventListener('click', api.clear);
    return api;
  }

  return { create, bindDrop, metaParts };
})();
