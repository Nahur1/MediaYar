'use strict';
/* Small DOM / formatting toolkit shared by all pages. */
window.UI = (() => {
  const P = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICONS = {
    film: P('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18"/>'),
    music: P('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    scissors: P('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>'),
    list: P('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
    sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
    moon: P('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
    upload: P('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>'),
    trash: P('<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    x: P('<path d="M18 6 6 18M6 6l12 12"/>'),
    play: P('<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/>'),
    pause: P('<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>'),
    stop: P('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
    folder: P('<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>'),
    external: P('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    check: P('<path d="M20 6 9 17l-5-5"/>'),
    alert: P('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>'),
    refresh: P('<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>'),
    save: P('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'),
    flagStart: P('<path d="M5 3v18"/><path d="M5 4h11l-2 4 2 4H5"/>'),
    flagEnd: P('<path d="M19 3v18"/><path d="M19 4H8l2 4-2 4h11"/>'),
    back5: P('<path d="M11 17 6 12l5-5M18 17l-5-5 5-5"/>'),
    fwd5: P('<path d="m13 17 5-5-5-5M6 17l5-5-5-5"/>'),
    file: P('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
    download: P('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>'),
    share: P('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>'),
    install: P('<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 7v7M9 11l3 3 3-3M10 18h4"/>'),
    monitor: P('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    record: P('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>'),
    region: P('<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="8" y="8" width="8" height="8" rx="1"/>'),
    mic: P('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/>'),
    cpu: P('<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'),
  };

  function hydrateIcons(root = document) {
    root.querySelectorAll('i[data-icon]').forEach((el) => {
      if (!el.firstChild) el.innerHTML = ICONS[el.dataset.icon] || '';
    });
  }
  const icon = (name) => {
    const i = document.createElement('i');
    i.dataset.icon = name;
    i.innerHTML = ICONS[name] || '';
    return i;
  };

  const $ = (sel, root = document) => root.querySelector(sel);

  /** Tiny hyperscript: h('div', {class:'x', onclick}, child, 'text') */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function fmtBytes(b) {
    if (!b && b !== 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  }

  function fmtDur(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const s = Math.round(sec);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
  }

  function fmtTime(sec) {
    const t = Math.max(0, sec || 0);
    const ms = Math.round(t * 1000);
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
  }

  function parseTime(input) {
    const s = String(input == null ? '' : input).trim()
      .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      .replace(/[٫,]/g, '.');
    if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(s)) return NaN;
    return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function toast(msg, type = 'info', ms = 3200) {
    const el = h('div', { class: `toast ${type}`, role: 'status' }, icon(type === 'error' ? 'alert' : 'check'), h('span', { text: msg }));
    $('#toasts').append(el);
    setTimeout(() => el.remove(), ms);
  }

  /** Persisted settings object (localStorage). */
  function store(key, defaults) {
    let data = { ...defaults };
    try {
      Object.assign(data, JSON.parse(localStorage.getItem(key) || '{}'));
    } catch { /* ignore */ }
    return new Proxy(data, {
      set(target, prop, value) {
        target[prop] = value;
        try { localStorage.setItem(key, JSON.stringify(target)); } catch { /* ignore */ }
        return true;
      },
    });
  }

  /**
   * Generic single-choice group (segmented control, chips or option cards).
   * options: [{value, label, hint?, cls?, title?}]
   */
  function choice(root, { options, value, onChange, kind = 'seg' }) {
    let current = value;
    let opts = options;
    const render = () => {
      root.replaceChildren(...opts.map((o) => {
        const cls = kind === 'chip' ? 'chip' : kind === 'opt' ? 'opt' : '';
        const btn = h('button', {
          type: 'button',
          class: `${cls} ${o.cls || ''} ${String(o.value) === String(current) ? 'active' : ''}`.trim(),
          title: o.title || null,
          'aria-pressed': String(String(o.value) === String(current)),
          onclick: () => api.set(o.value, true),
        });
        if (kind === 'opt') btn.append(h('b', { text: o.label }), o.hint ? h('small', { text: o.hint }) : null);
        else btn.textContent = o.label;
        btn.dataset.value = o.value;
        return btn;
      }));
    };
    const api = {
      get value() { return current; },
      set(v, user) {
        if (!opts.some((o) => String(o.value) === String(v))) v = opts[0] && opts[0].value;
        current = v;
        root.querySelectorAll('button').forEach((b) => {
          const on = b.dataset.value === String(v);
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', String(on));
        });
        if (user && onChange) onChange(v);
      },
      setOptions(next, v) {
        opts = next;
        if (v !== undefined) current = v;
        if (!opts.some((o) => String(o.value) === String(current))) current = opts[0] && opts[0].value;
        render();
      },
    };
    render();
    return api;
  }

  function fillSelect(sel, options, value) {
    // Wrap Latin runs in LRI/PDI so labels like "192 kbps (پیشنهادی)" render correctly in RTL.
    const iso = (t) => String(t).replace(/[A-Za-z0-9][A-Za-z0-9 .×()/:-]*[A-Za-z0-9)]|[A-Za-z0-9]/g, (m) => `\u2066${m}\u2069`);
    sel.replaceChildren(...options.map((o) => h('option', { value: o.value, text: iso(o.label) })));
    sel.value = String(value);
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  }

  return { ICONS, hydrateIcons, icon, $, h, fmtBytes, fmtDur, fmtTime, parseTime, debounce, toast, store, choice, fillSelect };
})();
