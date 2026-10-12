'use strict';
(() => {
  const q = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  const $ = (id) => document.getElementById(id);
  const fa = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  const PAUSE = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
  const PLAY = '<path d="M7 4l13 8-13 8z"/>';
  let paused = false;
  window.aux.onStatus((s) => {
    document.body.dataset.state = s.state;
    if (s.state === 'countdown') {
      $('time').textContent = fa(s.n);
      $('state').textContent = 'شروع ضبط تا لحظاتی دیگر…';
    } else {
      $('time').textContent = s.time || '00:00';
      $('state').textContent = s.state === 'paused' ? 'متوقف موقت' : 'در حال ضبط';
    }
    paused = s.state === 'paused';
    $('pause').querySelector('svg').innerHTML = paused ? PLAY : PAUSE;
    $('pause').title = paused ? 'ادامه‌ی ضبط' : 'توقف موقت';
    $('pause').disabled = s.state === 'countdown';
  });
  $('pause').addEventListener('click', () => window.aux.command(paused ? 'resume' : 'pause'));
  $('stop').addEventListener('click', () => window.aux.command('stop'));
})();
