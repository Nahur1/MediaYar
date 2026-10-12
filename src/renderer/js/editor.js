'use strict';
window.EditorPage = {
  init({ cat, go }) {
    const { $, h, icon, choice, fillSelect, store, toast, debounce, fmtBytes, fmtDur, fmtTime, parseTime } = UI;
    const s = store('mediayar.editor', { precise: true, compress: 'none', codec: 'h264', resolution: 'auto', format: 'mp4' });
    const MIN_GAP = 0.1;
    const STRIP_FRAMES = 12;

    const video = $('#ed-video');
    const frameImg = $('#ed-frame');
    const timeline = $('#timeline');
    const track = $('#tl-track');
    const startIn = $('#ed-start');
    const endIn = $('#ed-end');
    const sizeIn = $('#ed-size');
    const codecSel = $('#ed-codec');
    const resSel = $('#ed-res');
    const summary = $('#ed-summary');
    const cta = $('#ed-save');

    let file = null; // probe summary
    let start = 0;
    let end = 0;
    let cur = 0;
    let fallback = false;
    let loadToken = 0;
    let lastPlan = null;
    let cutMode = 'keep'; // per file, intentionally not persisted
    const edit = { crop: 'none', rotate: 0, flip: 'none', mute: false };

    /* ------------------------------------------------------------ options */
    const cropC = choice($('#ed-crop'), {
      kind: 'chip',
      options: [{ value: 'none', label: 'بدون', cls: 'label-fa' }, ...cat.aspects.map((a) => ({ value: a, label: a }))],
      value: 'none', onChange: (v) => { edit.crop = v; refreshPlan(); },
    });
    const rotC = choice($('#ed-rotate'), {
      options: [{ value: 0, label: 'بدون' }, { value: 90, label: 'ساعت‌گرد', title: '90 درجه ساعت‌گرد' }, { value: 270, label: 'پادساعت‌گرد', title: '90 درجه پادساعت‌گرد' }, { value: 180, label: '180°' }],
      value: 0, onChange: (v) => { edit.rotate = Number(v); refreshPlan(); },
    });
    const flipC = choice($('#ed-flip'), {
      options: [{ value: 'none', label: 'بدون' }, { value: 'h', label: 'افقی' }, { value: 'v', label: 'عمودی' }],
      value: 'none', onChange: (v) => { edit.flip = v; refreshPlan(); },
    });
    const cutC = choice($('#ed-cutmode'), {
      options: [{ value: 'keep', label: 'نگه داشتن بازه' }, { value: 'remove', label: 'حذف بازه' }],
      value: 'keep', onChange: (v) => { cutMode = v; renderTimeline(); refreshPlan(); },
    });
    choice($('#ed-compress'), {
      kind: 'opt',
      options: [
        { value: 'none', label: 'بدون کاهش', hint: 'بیشترین کیفیت' },
        { value: 'smart', label: 'هوشمند', hint: 'حفظ کیفیت، حجم کمتر' },
        { value: 'r2', label: '½ حجم', hint: 'نصف حجم فعلی' },
        { value: 'r3', label: '⅓ حجم', hint: 'یک‌سوم حجم فعلی' },
        { value: 'r4', label: '¼ حجم', hint: 'یک‌چهارم حجم فعلی' },
        { value: 'r5', label: '⅕ حجم', hint: 'یک‌پنجم حجم فعلی' },
        { value: 'size', label: 'حجم دلخواه', hint: 'حجم نهایی را خودتان تعیین کنید (مگابایت)', cls: 'wide' },
      ],
      value: s.compress, onChange: (v) => { s.compress = v; syncCompress(); refreshPlan(); },
    });
    const fmtC = choice($('#ed-format'), {
      kind: 'chip',
      options: Object.entries(cat.editorFormats).map(([value, f]) => ({ value, label: f.label })),
      value: s.format, onChange: (v) => { s.format = v; syncCodecs(); refreshPlan(); },
    });
    fillSelect(resSel, [
      { value: 'auto', label: 'خودکار (پیشنهادی)' },
      { value: 'original', label: 'مانند اصلی' },
      ...[1080, 720, 480, 360].map((r) => ({ value: r, label: `${r}p` })),
    ], s.resolution);
    resSel.addEventListener('change', () => { s.resolution = resSel.value; refreshPlan(); });
    codecSel.addEventListener('change', () => { s.codec = codecSel.value; refreshPlan(); });
    sizeIn.addEventListener('input', () => refreshPlan());
    const precise = $('#ed-precise');
    precise.checked = !!s.precise;
    precise.addEventListener('change', () => { s.precise = precise.checked; refreshPlan(); });
    const mute = $('#ed-mute');
    mute.addEventListener('change', () => { edit.mute = mute.checked; refreshPlan(); });

    function syncCodecs() {
      const f = cat.editorFormats[s.format] || cat.editorFormats.mp4;
      const labels = { h264: 'H.264 (سازگار)', h265: 'H.265 (کم‌حجم)', vp9: 'VP9', vp8: 'VP8' };
      fillSelect(codecSel, f.codecs.map((c) => ({ value: c, label: labels[c] || c })), f.codecs.includes(s.codec) ? s.codec : f.codecs[0]);
      codecSel.disabled = f.codecs.length < 2;
    }
    function syncCompress() {
      $('#ed-size-wrap').hidden = s.compress !== 'size';
      if (s.compress === 'size' && !sizeIn.value && file) sizeIn.value = Math.max(1, Math.round(file.size / 2 / 1048576));
    }

    function options() {
      const cm = s.compress;
      const compress = { mode: 'none' };
      if (cm === 'smart') compress.mode = 'smart';
      else if (/^r\d$/.test(cm)) Object.assign(compress, { mode: 'ratio', ratio: 1 / Number(cm.slice(1)) });
      else if (cm === 'size') Object.assign(compress, { mode: 'size', sizeMB: Number(sizeIn.value) });
      compress.codec = codecSel.value;
      compress.resolution = resSel.value === 'auto' || resSel.value === 'original' ? resSel.value : Number(resSel.value);
      return { start, end, cutMode: cutMode, precise: !!s.precise, crop: edit.crop, rotate: edit.rotate, flip: edit.flip, mute: edit.mute, format: s.format, compress };
    }

    /* ------------------------------------------------------------ preview */
    const refreshPlan = debounce(async () => {
      if (!file) return;
      const token = loadToken;
      const r = await window.api.preview('edit', file.path, options());
      if (token !== loadToken) return;
      lastPlan = r.error ? null : r;
      renderSummary(r);
    }, 160);

    function row(label, value, fa) {
      return h('div', { class: 'row' }, h('span', { text: label }), h('b', { class: fa ? 'fa' : null, text: value }));
    }

    function renderSummary(r) {
      summary.classList.toggle('error', !!r.error);
      cta.disabled = !!r.error;
      if (r.error) {
        summary.replaceChildren(h('div', { text: r.error }));
        return;
      }
      const i = r.info;
      const codecLabel = { h264: 'H.264', h265: 'H.265', vp9: 'VP9', vp8: 'VP8' }[i.codec] || (i.codec || '').toUpperCase();
      const rows = [
        row('روش', i.mode === 'copy' ? 'کپی مستقیم — بدون افت کیفیت' : `رمزگذاری ${codecLabel}${i.twoPass ? ' · دومرحله‌ای' : ''}`, true),
        row('مدت خروجی', fmtDur(i.duration)),
        row('ابعاد تصویر', `${i.width}×${i.height}`),
      ];
      let size = '—';
      if (i.targetBytes) {
        const segBytes = file.size * (i.duration / file.duration);
        size = `≈ ${fmtBytes(i.targetBytes)}  (${Math.round((1 - i.targetBytes / segBytes) * 100)}% کمتر)`;
      } else if (i.mode === 'copy') size = `≈ ${fmtBytes(file.size * (i.duration / file.duration))}`;
      else if (s.compress === 'smart') size = 'بسته به محتوا، کمتر از اصلی';
      rows.push(row('حجم تقریبی', size, s.compress === 'smart' && !i.targetBytes));
      rows.push(row('فرمت خروجی', i.mode === 'copy' ? `${r.ext.toUpperCase()} (مانند اصلی)` : r.ext.toUpperCase()));
      summary.replaceChildren(...rows);
    }

    /* ----------------------------------------------------------- timeline */
    const dur = () => (file ? file.duration : 0);
    const pct = (t) => `${(dur() ? (t / dur()) * 100 : 0).toFixed(4)}%`;
    const timeAt = (clientX) => {
      const r = track.getBoundingClientRect();
      return Math.min(dur(), Math.max(0, ((clientX - r.left) / r.width) * dur()));
    };

    // Cached refs + rAF batching: the timeline is redrawn at most once per frame.
    const tl = { sel: $('#tl-sel'), dimL: $('#tl-dim-l'), dimR: $('#tl-dim-r'), start: $('#tl-start'), end: $('#tl-end'), head: $('#tl-head'), time: $('#ed-time'), len: $('#ed-len') };
    let tlFrame = 0;
    let tlFull = false;
    function renderTimeline(headOnly = false) {
      if (!headOnly) tlFull = true;
      if (!tlFrame) tlFrame = requestAnimationFrame(drawTimeline);
    }
    function drawTimeline() {
      tlFrame = 0;
      tl.head.style.left = pct(cur);
      tl.time.textContent = fmtTime(cur);
      if (!tlFull) return;
      tlFull = false;
      timeline.classList.toggle('remove', cutMode === 'remove');
      tl.sel.style.left = pct(start);
      tl.sel.style.width = `calc(${pct(end)} - ${pct(start)})`;
      tl.dimL.style.width = pct(start);
      tl.dimR.style.width = `calc(100% - ${pct(end)})`;
      tl.start.style.left = pct(start);
      tl.end.style.left = pct(end);
      if (document.activeElement !== startIn) { startIn.value = fmtTime(start); startIn.classList.remove('invalid'); }
      if (document.activeElement !== endIn) { endIn.value = fmtTime(end); endIn.classList.remove('invalid'); }
      const len = cutMode === 'remove' ? dur() - (end - start) : end - start;
      tl.len.textContent = fmtTime(len);
    }

    const requestFrame = debounce(async (t) => {
      if (!fallback || !file) return;
      const token = loadToken;
      const src = await window.api.frame(file.path, t, 960);
      if (src && token === loadToken) frameImg.src = src;
    }, 90);

    // Scrubbing: never queue more than one pending seek (keeps dragging smooth on long files).
    let pendingSeek = null;
    video.addEventListener('seeked', () => {
      if (pendingSeek == null) return;
      const t = pendingSeek;
      pendingSeek = null;
      video.currentTime = t;
    });
    function seek(t) {
      cur = Math.min(dur(), Math.max(0, t));
      if (fallback) requestFrame(cur);
      else if (Number.isFinite(video.duration)) {
        if (video.seeking) pendingSeek = cur;
        else video.currentTime = cur;
      }
      renderTimeline(true);
    }

    function setRange(a, b, which) {
      const d = dur();
      if (which === 'start') start = Math.min(Math.max(0, a), end - MIN_GAP);
      else if (which === 'end') end = Math.max(Math.min(d, b), start + MIN_GAP);
      else {
        start = Math.max(0, Math.min(a, d - MIN_GAP));
        end = Math.min(d, Math.max(b, start + MIN_GAP));
      }
      renderTimeline();
      refreshPlan();
    }

    function dragHandle(el, which) {
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        pause();
        const move = (ev) => {
          const t = timeAt(ev.clientX);
          if (which === 'start') setRange(t, end, 'start');
          else setRange(start, t, 'end');
          seek(which === 'start' ? start : end);
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
      el.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 1 : 0.1;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const delta = e.key === 'ArrowRight' ? step : -step;
        if (which === 'start') setRange(start + delta, end, 'start');
        else setRange(start, end + delta, 'end');
        seek(which === 'start' ? start : end);
      });
    }
    dragHandle($('#tl-start'), 'start');
    dragHandle($('#tl-end'), 'end');

    track.addEventListener('pointerdown', (e) => {
      if (!file) return;
      track.setPointerCapture(e.pointerId);
      seek(timeAt(e.clientX));
      const move = (ev) => seek(timeAt(ev.clientX));
      const up = () => {
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
      };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
    });

    function bindTimeInput(input, which) {
      const commit = () => {
        const t = parseTime(input.value);
        if (!Number.isFinite(t) || t < 0 || t > dur() + 0.001) {
          input.classList.add('invalid');
          return;
        }
        input.classList.remove('invalid');
        if (which === 'start') setRange(t, end, 'start');
        else setRange(start, t, 'end');
        seek(which === 'start' ? start : end);
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); input.blur(); } });
      input.addEventListener('blur', () => renderTimeline());
    }
    bindTimeInput(startIn, 'start');
    bindTimeInput(endIn, 'end');

    /* ------------------------------------------------------------ playback */
    const playBtn = $('#ed-play');
    let raf = 0;
    function setPlayIcon(playing) {
      playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
      playBtn.setAttribute('aria-label', playing ? 'توقف' : 'پخش');
    }
    function tick() {
      cur = video.currentTime;
      if (cutMode === 'keep' && cur >= end) {
        pause();
        cur = end;
      }
      renderTimeline(true);
      if (!video.paused) raf = requestAnimationFrame(tick);
    }
    function play() {
      if (fallback || !file) return;
      if (cutMode === 'keep' && (cur < start || cur >= end - 0.05)) seek(start);
      video.play().catch(() => {});
    }
    function pause() {
      if (!video.paused) video.pause();
    }
    video.addEventListener('play', () => { setPlayIcon(true); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); });
    video.addEventListener('pause', () => { setPlayIcon(false); cancelAnimationFrame(raf); });
    video.addEventListener('ended', () => setPlayIcon(false));
    playBtn.addEventListener('click', () => (video.paused ? play() : pause()));
    $('#ed-back').addEventListener('click', () => seek(cur - 5));
    $('#ed-fwd').addEventListener('click', () => seek(cur + 5));
    $('#ed-set-start').addEventListener('click', () => setRange(cur, end, 'start'));
    $('#ed-set-end').addEventListener('click', () => setRange(start, cur, 'end'));

    function useFallback() {
      if (fallback) return;
      fallback = true;
      video.removeAttribute('src');
      video.load();
      video.hidden = true;
      frameImg.hidden = false;
      $('#ed-note').hidden = false;
      playBtn.disabled = true;
      requestFrame(cur);
    }
    video.addEventListener('error', () => { if (file) useFallback(); });
    video.addEventListener('loadedmetadata', () => { if (file && !video.videoWidth) useFallback(); });

    document.addEventListener('keydown', (e) => {
      if (!file || !$('#page-editor').classList.contains('active')) return;
      if (e.target.closest('input, select, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); video.paused ? play() : pause(); }
      else if (e.key === 'i' || e.key === 'I' || e.key === 'ه') setRange(cur, end, 'start');
      else if (e.key === 'o' || e.key === 'O' || e.key === 'خ') setRange(start, cur, 'end');
      else if (e.key === 'ArrowLeft' && !e.target.closest('.tl-handle')) seek(cur - (e.shiftKey ? 5 : 1));
      else if (e.key === 'ArrowRight' && !e.target.closest('.tl-handle')) seek(cur + (e.shiftKey ? 5 : 1));
    });

    /* ----------------------------------------------------------- filmstrip */
    async function buildStrip(token) {
      const strip = $('#tl-strip');
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = Math.max(32, Math.round(((strip.clientWidth || 600) / STRIP_FRAMES) * dpr));
      const ch = Math.max(24, Math.round((strip.clientHeight || 56) * dpr));
      const canvases = Array.from({ length: STRIP_FRAMES }, () => h('canvas', { width: cw, height: ch }));
      strip.replaceChildren(...canvases);
      const times = canvases.map((_, i) => ((i + 0.5) * dur()) / STRIP_FRAMES);
      const stale = () => token !== loadToken;
      const caps = (window.APP && window.APP.caps) || {};
      // Desktop: native ffmpeg grabs frames fastest (several in parallel).
      // Web: the browser's own decoder is much faster than ffmpeg.wasm; wasm covers the rest.
      let next = caps.fastFrames ? 0 : await Thumbs.fill(window.api.fileUrl(file.path), times, canvases, stale);
      const worker = async () => {
        while (next < STRIP_FRAMES && !stale()) {
          const i = next++;
          const src = await window.api.frame(file.path, times[i], cw);
          if (src && !stale()) Thumbs.drawUrl(canvases[i], src);
        }
      };
      await Promise.all(Array.from({ length: caps.fastFrames ? 3 : 1 }, worker));
    }

    /* ---------------------------------------------------------- file load */
    async function load(paths) {
      const p = paths && paths[0];
      if (!p) return;
      const r = await window.api.probe(p);
      if (r.error) return toast(r.error, 'error');
      if (!r.summary.hasVideo) return toast('این فایل تصویر ویدیویی ندارد.', 'error');
      if (!r.summary.duration) return toast('مدت زمان این ویدیو قابل تشخیص نیست.', 'error');
      const token = ++loadToken;
      file = r.summary;
      start = 0;
      end = file.duration;
      cur = 0;
      fallback = false;
      Object.assign(edit, { crop: 'none', rotate: 0, flip: 'none', mute: false });
      cropC.set('none'); rotC.set(0); flipC.set('none');
      cutMode = 'keep';
      cutC.set('keep');
      mute.checked = false;
      $('#ed-mute').closest('.switch').classList.toggle('disabled', !file.hasAudio);
      sizeIn.value = Math.max(1, Math.round(file.size / 2 / 1048576));
      video.hidden = false;
      frameImg.hidden = true;
      frameImg.removeAttribute('src');
      $('#ed-note').hidden = true;
      playBtn.disabled = false;
      setPlayIcon(false);
      video.src = window.api.fileUrl(file.path);
      $('#editor-drop').hidden = true;
      $('#editor').hidden = false;
      renderFileChip();
      renderTimeline();
      syncCompress();
      refreshPlan();
      buildStrip(token);
      setTimeout(() => {
        if (token === loadToken && !fallback && video.readyState < 1) useFallback();
      }, 4000);
    }

    function renderFileChip() {
      const chip = $('#ed-file');
      chip.replaceChildren(
        h('div', { class: 'file-icon' }, icon('film')),
        h('div', { class: 'file-body' },
          h('div', { class: 'file-name', dir: 'auto', title: file.path, text: file.path.split(/[\\/]/).pop() }),
          h('div', { class: 'file-meta' }, ...FileList.metaParts(file).map((t) => h('span', { text: t })))),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => load(await window.api.openFiles('video', false)) }, icon('refresh'), 'تغییر فایل'),
      );
    }

    cta.addEventListener('click', async () => {
      if (!file || !lastPlan) return;
      const dest = await SaveAsk.forJobs({ key: 'editor', items: [{ path: file.path, name: file.name || file.path }], ext: lastPlan.ext, suffix: 'edited', title: 'ذخیره‌ی ویدیوی ویرایش‌شده' });
      if (!dest) return;
      const added = await window.api.addJobs([{ kind: 'edit', input: file.path, opts: options(), ...dest[0], label: lastPlan.ext.toUpperCase() }]);
      if (added.length) {
        toast('ویرایش به صف اضافه شد');
        pause();
        go('queue');
      }
    });

    FileList.bindDrop($('#editor-drop'), 'video', load, false);
    fmtC.set(s.format);
    syncCodecs();
    syncCompress();
    return { load, pause };
  },
};
