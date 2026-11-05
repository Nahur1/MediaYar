'use strict';
window.QueuePage = {
  init() {
    const { $, h, icon, fmtBytes, fmtDur } = UI;
    const jobs = new Map(); // id -> { data, el, refs }
    const listEl = $('#jobs');
    const STATUS = { queued: 'در انتظار', running: 'در حال پردازش', done: 'انجام شد', error: 'خطا', canceled: 'لغو شد' };
    const KIND_ICON = { video: 'film', audio: 'music', edit: 'scissors' };

    function card(j) {
      const refs = {
        status: h('span', { class: 'status' }),
        bar: h('span'),
        pct: h('span', { class: 'pct', dir: 'ltr' }),
        speed: h('span', { dir: 'ltr' }),
        eta: h('span'),
        result: h('div', { class: 'job-result' }),
        actions: h('div', { class: 'job-actions' }),
        details: h('details', { hidden: true }, h('summary', { text: 'جزئیات فنی' }), h('pre')),
      };
      refs.line = h('div', { class: 'job-line' },
        h('div', { class: 'bar' }, refs.bar),
        h('div', { class: 'job-meta' }, refs.speed, refs.eta, refs.pct));
      const el = h('div', { class: 'job' },
        h('div', { class: 'job-icon' }, icon(KIND_ICON[j.kind] || 'file')),
        h('div', { class: 'job-title' }, h('b', { dir: 'auto', title: j.input, text: j.name }), j.label ? h('span', { class: 'job-target', text: j.label }) : null),
        refs.status,
        refs.line,
        h('div', { class: 'job-line result-line' }, refs.result, refs.actions),
        refs.details);
      return { el, refs, lastStatus: null };
    }

    function actionBtn(label, ic, onclick, cls = 'btn sm') {
      return h('button', { class: cls, type: 'button', onclick }, icon(ic), label);
    }

    function update(j) {
      let entry = jobs.get(j.id);
      if (!entry) {
        entry = card(j);
        jobs.set(j.id, entry);
        listEl.prepend(entry.el);
      }
      entry.data = j;
      const { refs, el } = entry;
      el.className = `job ${j.status}`;
      refs.status.className = `status ${j.status}`;
      refs.status.textContent = STATUS[j.status] || j.status;
      const p = Math.round((j.progress || 0) * 100);
      refs.bar.style.transform = `scaleX(${j.status === 'done' ? 1 : (j.progress || 0).toFixed(4)})`;
      refs.pct.textContent = j.status === 'running' || j.status === 'done' ? `${j.status === 'done' ? 100 : p}%` : '';
      refs.speed.textContent = j.status === 'running' && j.speed ? `${j.speed.toFixed(1)}x` : '';
      refs.eta.textContent = j.status === 'running' && j.eta != null ? `${fmtDur(j.eta)} باقی‌مانده` : '';
      refs.line.hidden = j.status === 'error' || j.status === 'canceled';

      if (entry.lastStatus !== j.status) {
        entry.lastStatus = j.status;
        refs.actions.replaceChildren();
        refs.result.className = 'job-result';
        refs.result.textContent = '';
        refs.details.hidden = true;
        if (j.status === 'queued' || j.status === 'running') {
          refs.result.textContent = j.status === 'queued' ? 'در صف انتظار…' : '';
          refs.actions.append(actionBtn('لغو', 'x', () => window.api.cancelJob(j.id), 'btn sm danger'));
        } else if (j.status === 'done') {
          const diff = j.inputSize ? Math.round((1 - j.outputSize / j.inputSize) * 100) : 0;
          refs.result.append(
            'حجم: ',
            h('bdi', { dir: 'ltr', text: fmtBytes(j.inputSize) }),
            ' ← ',
            h('b', {}, h('bdi', { dir: 'ltr', text: fmtBytes(j.outputSize) })),
            diff > 0 ? h('span', { class: 'delta' }, ' · ', h('bdi', { dir: 'ltr', text: `${diff}%` }), ' کوچک‌تر') : '',
            diff < 0 ? h('span', { class: 'delta' }, ' · ', h('bdi', { dir: 'ltr', text: `${-diff}%` }), ' بزرگ‌تر') : '',
          );
          const caps = (window.APP && window.APP.caps) || {};
          if (caps.download) refs.actions.append(actionBtn('دانلود', 'download', () => window.api.download(j.output), 'btn sm primary'));
          if (caps.play !== false) refs.actions.append(actionBtn('پخش', 'play', () => window.api.openPath(j.output)));
          if (caps.share) refs.actions.append(actionBtn(caps.nativeExport ? 'ذخیره / اشتراک' : 'اشتراک', 'share', async () => {
            try { await window.api.share(j.output); }
            catch { UI.toast('اشتراک فایل انجام نشد؛ دوباره تلاش کنید.', 'error'); }
          }));
          if (caps.reveal) refs.actions.append(actionBtn('نمایش در پوشه', 'folder', () => window.api.reveal(j.output)));
          if (j.outputName) refs.result.append(h('div', { class: 'job-out', dir: 'auto', title: j.outputName, text: j.outputName }));
        } else if (j.status === 'error') {
          refs.result.className = 'job-result err';
          refs.result.textContent = j.error || 'خطا';
          refs.actions.append(actionBtn('تلاش دوباره', 'refresh', () => window.api.retryJob(j.id)));
          if (j.errorDetails) {
            refs.details.hidden = false;
            refs.details.querySelector('pre').textContent = j.errorDetails;
          }
        } else if (j.status === 'canceled') {
          refs.result.textContent = 'این کار لغو شد.';
          refs.actions.append(actionBtn('تلاش دوباره', 'refresh', () => window.api.retryJob(j.id)));
        }
      }
      summarize();
    }

    function summarize() {
      const all = [...jobs.values()].map((e) => e.data);
      $('#jobs-empty').hidden = all.length > 0;
      const active = all.filter((j) => j.status === 'running' || j.status === 'queued');
      const badge = $('#queue-badge');
      badge.hidden = active.length === 0;
      badge.textContent = String(active.length);
      const running = all.find((j) => j.status === 'running');
      $('#mini').hidden = !running;
      if (running) {
        $('#mini-name').textContent = running.name;
        $('#mini-name').title = running.name;
        $('#mini-bar').style.transform = `scaleX(${running.progress.toFixed(4)})`;
        $('#mini-meta').replaceChildren(
          h('span', { text: `${Math.round(running.progress * 100)}%`, dir: 'ltr' }),
          h('span', { text: active.length > 1 ? `${active.length - 1} کار دیگر در صف` : running.eta != null ? `${fmtDur(running.eta)} مانده` : '' }),
        );
      }
    }

    $('#q-cancel-all').addEventListener('click', () => window.api.cancelAll());
    $('#q-clear').addEventListener('click', async () => {
      const remaining = new Set((await window.api.clearJobs()).map((j) => j.id));
      for (const [id, e] of jobs) {
        if (!remaining.has(id)) {
          e.el.remove();
          jobs.delete(id);
        }
      }
      summarize();
    });

    window.api.onJobUpdate(update);
    window.api.listJobs().then((list) => list.forEach(update));
    summarize();
  },
};
