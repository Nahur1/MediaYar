'use strict';
(async function main() {
  const { $, hydrateIcons } = UI;

  // Never let a stray drop navigate the window away.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  const init = await window.api.init();
  window.APP = init; // platform info + capabilities (desktop vs web)
  document.documentElement.dataset.platform = init.platform === 'web' ? 'web' : 'desktop';
  const cat = init.catalog;

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    document.querySelectorAll('[data-theme-btn]').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeBtn === t);
      b.setAttribute('aria-pressed', String(b.dataset.themeBtn === t));
    });
  }
  applyTheme(init.theme);
  document.querySelectorAll('[data-theme-btn]').forEach((b) => b.addEventListener('click', async () => applyTheme(await window.api.setTheme(b.dataset.themeBtn))));

  let editor = null;
  function go(page) {
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.page === page);
      if (n.dataset.page === page) n.setAttribute('aria-current', 'page');
      else n.removeAttribute('aria-current');
    });
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
    if (page !== 'editor' && editor) editor.pause();
    $('.main').scrollTop = 0;
  }
  document.querySelectorAll('.nav-item').forEach((n) => n.addEventListener('click', () => go(n.dataset.page)));

  const ctx = { cat, go };
  window.Pages = {
    video: VideoPage.init(ctx),
    audio: AudioPage.init(ctx),
    editor: (editor = EditorPage.init(ctx)),
    record: RecordPage.init(ctx),
    queue: QueuePage.init(ctx),
    go,
  };
  // Static icons are hydrated once; dynamic ones are created already filled by UI.icon().
  hydrateIcons();
  if (window.WebExtras) WebExtras.init(init);
  document.body.dataset.ready = '1';
})();
