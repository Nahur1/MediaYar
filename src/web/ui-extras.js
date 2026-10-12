'use strict';
/* Web-only UI touches: engine download indicator, PWA install button, privacy note. */
window.WebExtras = {
  init() {
    const { h, icon, fmtBytes, toast } = UI;
    const sidebar = document.querySelector('.sidebar');
    const theme = sidebar.querySelector('.theme-switch');
    sidebar.insertBefore(h('div', { class: 'web-note', text: 'پردازش کاملاً روی دستگاه شما انجام می‌شود و فایلی آپلود نمی‌شود.' }), theme);

    // Engine download progress (first visit only; afterwards it's served from cache).
    let pill = null;
    let showTimer = 0;
    window.api.onEngineProgress((p) => {
      if (p.done || p.error) {
        clearTimeout(showTimer);
        if (pill) pill.remove();
        pill = null;
        if (p.error) toast('دریافت موتور پردازش ناموفق بود؛ اتصال اینترنت را بررسی کنید.', 'error', 6000);
        return;
      }
      if (!pill && !showTimer) {
        showTimer = setTimeout(() => {
          pill = h('div', { class: 'engine-pill', role: 'status' }, icon('cpu'), h('span', { class: 'lbl' }), h('div', { class: 'bar' }, h('span')));
          document.body.append(pill);
          render();
        }, 400);
      }
      last = p;
      render();
    });
    let last = null;
    function render() {
      if (!pill || !last) return;
      pill.querySelector('.lbl').textContent = `آماده‌سازی موتور پردازش… ${Math.round((last.ratio || 0) * 100)}٪ (${fmtBytes(last.total || 0)})`;
      pill.querySelector('.bar > span').style.transform = `scaleX(${(last.ratio || 0).toFixed(3)})`;
    }

    // PWA install
    const btn = h('button', { class: 'btn sm install-btn', type: 'button', hidden: true, onclick: async () => { if (await window.api.install()) btn.hidden = true; } }, icon('install'), 'نصب برنامه');
    sidebar.insertBefore(btn, theme);
    const sync = () => { btn.hidden = !window.api.canInstall(); };
    document.addEventListener('mediayar:installable', sync);
    sync();
  },
};
