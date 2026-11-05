'use strict';
/**
 * "Where should this be saved?" — asked for every export.
 *  - one output   -> Save-as dialog (suggested folder + name, both changeable)
 *  - many outputs -> small dialog: next to originals / Downloads (default) or a chosen folder
 * Last choices become the next suggestion; nothing is ever saved silently.
 */
window.SaveAsk = (() => {
  const { h, icon, store } = UI;
  const caps = () => (window.APP && window.APP.caps) || {};
  const mem = store('mediayar.save', { dirs: {}, mode: {}, custom: {} });
  const webDirs = {}; // web folder handles only live for this session
  const dirname = (p) => { const s = String(p || ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i > 0 ? s.slice(0, i) : ''; };
  const basename = (p) => String(p).split(/[\\/]/).pop();
  const stem = (n) => basename(n).replace(/\.[^.]+$/, '') || 'output';
  const extOf = (n) => ((/\.([^.\\/]+)$/.exec(n) || [])[1] || '').toLowerCase();
  const remember = (bag, key, v) => { mem[bag] = { ...mem[bag], [key]: v }; };

  /** Generic modal. Resolves with the value passed to close(), or null on Esc / backdrop / ×. */
  function modal({ title, sub, body, actions, cls = '' }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      let wrap = null;
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        if (e.key === 'Tab' && wrap) {
          const controls = [...wrap.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el => el.getClientRects().length);
          const first = controls[0], last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      function close(v) {
        if (!wrap) return;
        wrap.remove();
        wrap = null;
        document.removeEventListener('keydown', onKey, true);
        if (prev && prev.focus) prev.focus();
        resolve(v === undefined ? null : v);
      }
      const card = h('div', { class: `modal ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'modal-head' },
          h('div', { class: 'modal-titles' }, h('b', { text: title }), sub ? h('span', { text: sub }) : null),
          h('button', { class: 'icon-btn modal-x', type: 'button', 'aria-label': 'بستن', onclick: () => close(null) }, icon('x'))),
        h('div', { class: 'modal-body' }, body(close)),
        h('div', { class: 'modal-actions' }, ...actions(close)));
      wrap = h('div', { class: 'modal-wrap', onmousedown: (e) => { if (e.target === wrap) close(null); } }, card);
      document.body.append(wrap);
      document.addEventListener('keydown', onKey, true);
      const first = card.querySelector('[data-autofocus]') || card.querySelector('.modal-actions .btn.primary');
      if (first) first.focus();
    });
  }

  /** Name-only dialog for browsers without a save picker (the file goes to Downloads). */
  async function askName({ name, ext, title }) {
    const input = h('input', { class: 'text-input', value: name, dir: 'auto', spellcheck: 'false', 'data-autofocus': '' });
    const r = await modal({
      title,
      body: (close) => {
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value); });
        return [
          h('label', { class: 'modal-label', text: 'نام فایل' }),
          h('div', { class: 'name-row' }, input, h('span', { class: 'ext', dir: 'ltr', text: `.${ext}` })),
          h('div', { class: 'loc' }, icon('download'), h('span', { text: caps().nativeExport ? 'پس از پایان پردازش، «ذخیره / اشتراک» را بزنید و مقصد فایل را انتخاب کنید.' : 'محل ذخیره: پوشه‌ی دانلودهای مرورگر (طبق تنظیمات مرورگر)' })),
        ];
      },
      actions: (close) => [
        h('button', { class: 'btn primary', type: 'button', onclick: () => close(input.value) }, icon('save'), 'ذخیره'),
        h('button', { class: 'btn ghost', type: 'button', text: 'انصراف', onclick: () => close(null) }),
      ],
    });
    if (r == null) return null;
    const n = (r.trim() || name).replace(new RegExp(`\\.${ext}$`, 'i'), '');
    return window.api.downloadTarget(`${n}.${ext}`);
  }

  /**
   * Ask for one output file. Returns a path/token, or null when the user cancels.
   * @param {{key:string, dir?:string, name:string, ext:string, title?:string, avoid?:string}} o
   */
  async function file(o) {
    const c = caps();
    const title = o.title || 'ذخیره در…';
    if (!c.saveDialog) return askName({ name: o.name, ext: o.ext, title });
    const dir = (c.reveal && mem.dirs[o.key]) || o.dir || '';
    const p = await window.api.saveFile({ key: o.key, dir, name: `${o.name}.${o.ext}`, ext: o.ext, title, avoid: o.avoid });
    if (p && c.reveal) remember('dirs', o.key, dirname(p));
    return p;
  }

  /** Ask for a destination folder for several outputs. Resolves {outputDir} or null. */
  async function folder({ key, count, title }) {
    const c = caps();
    const def = c.defaultOut || 'کنار فایل اصلی';
    let custom = c.reveal ? mem.custom[key] || null : webDirs[key] || null;
    let mode = mem.mode[key] === 'custom' && custom ? 'custom' : 'default';
    const pathText = h('div', { class: 'opt-path', dir: 'auto' });
    const optDef = h('button', { type: 'button', class: 'opt wide', 'data-save': 'default', onclick: () => pick('default') },
      h('b', {}, icon(c.reveal ? 'folder' : 'download'), def),
      h('small', { text: c.reveal ? 'هر خروجی در همان پوشه‌ی فایل اصلی خودش ذخیره می‌شود (پیش‌فرض)' : c.nativeExport ? 'پس از پایان، با «ذخیره / اشتراک» فایل‌ها را به محل دلخواه بفرستید.' : 'فایل‌ها به پوشه‌ی دانلودهای مرورگر می‌روند (پیش‌فرض)' }));
    const choose = h('button', {
      class: 'btn sm', type: 'button', 'data-save': 'choose', onclick: async (e) => {
        e.stopPropagation();
        const d = await window.api.openFolder();
        if (!d) return;
        custom = d;
        if (c.reveal) remember('custom', key, d); else webDirs[key] = d;
        pick('custom');
      },
    }, icon('folder'), 'انتخاب پوشه…');
    const optCustom = h('div', { class: 'opt wide custom', role: 'button', tabindex: '0', 'data-save': 'custom', onclick: () => (custom ? pick('custom') : choose.click()) },
      h('b', {}, icon('folder'), 'پوشه‌ی دلخواه'), pathText, choose);
    function pick(m) {
      mode = m === 'custom' && custom ? 'custom' : 'default';
      optDef.classList.toggle('active', mode === 'default');
      optCustom.classList.toggle('active', mode === 'custom');
      pathText.textContent = custom || 'هنوز پوشه‌ای انتخاب نشده';
      pathText.classList.toggle('muted', !custom);
    }
    pick(mode);
    const ok = await modal({
      title: title || 'خروجی‌ها کجا ذخیره شوند؟',
      sub: count > 1 ? `${count} فایل خروجی` : null,
      body: () => [h('div', { class: 'save-opts' }, optDef, c.outputDir ? optCustom : null)],
      actions: (close) => [
        h('button', { class: 'btn primary', type: 'button', 'data-save': 'ok', onclick: () => close(true) }, icon('check'), 'ادامه'),
        h('button', { class: 'btn ghost', type: 'button', text: 'انصراف', onclick: () => close(null) }),
      ],
    });
    if (!ok) return null;
    remember('mode', key, mode);
    return { outputDir: mode === 'custom' ? custom : null };
  }

  /** Suggested output name for a source file (same rules as the automatic naming). */
  function suggestName(src, ext, suffix) {
    const s = stem(src);
    if (suffix) return `${s}_${suffix}`;
    return extOf(src) === ext ? `${s}_converted` : s;
  }

  /**
   * Destination for a batch of jobs: Save-as for one file, a folder choice for several.
   * Resolves an array of partial job specs ({outputPath} or {outputDir}) or null if canceled.
   */
  async function forJobs({ key, items, ext, suffix, title }) {
    if (items.length === 1) {
      const src = items[0].path;
      const p = await file({ key, dir: caps().reveal ? dirname(src) : '', name: suggestName(items[0].name || src, ext, suffix), ext, title, avoid: src });
      return p ? [{ outputPath: p }] : null;
    }
    const r = await folder({ key, count: items.length, title });
    return r ? items.map(() => ({ outputDir: r.outputDir })) : null;
  }

  return { modal, file, folder, forJobs, suggestName, dirname, basename };
})();
