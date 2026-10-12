'use strict';
/**
 * Screen recorder page. Capture = getDisplayMedia (+ optional microphone, mixed with Web Audio),
 * encoding = MediaRecorder streamed in 1 s chunks to a sink (temp file on desktop, Blobs on the
 * web), finishing = a 'record' job in the shared queue (crop / remux / encode to a clean file).
 */
window.RecordPage = {
  init({ go }) {
    const { $, h, icon, choice, fillSelect, store, toast } = UI;
    const APP = window.APP;
    const caps = APP.caps || {};
    const isWeb = APP.platform === 'web';
    const api = window.api;
    const s = store('mediayar.record', { mode: 'full', audio: 'none', fps: 30, quality: 'high', hide: true, countdown: true, displayId: null, region: null });
    const nav = $('#nav-record');
    if (!caps.screenRecord) {
      nav.hidden = true;
      return { busy: () => false };
    }

    const preview = $('#rec-preview');
    const view = $('#rec-view');
    const area = $('#rec-area');
    const startBtn = $('#rec-start');
    const pauseBtn = $('#rec-pause');
    const stopBtn = $('#rec-stop');
    let displays = [];
    let recDir = null;
    let state = 'idle'; // idle | starting | countdown | recording | paused | saving
    let ses = null;

    /* ------------------------------------------------------------ settings UI */
    const modeC = choice($('#rec-mode'), {
      kind: 'opt',
      options: [
        { value: 'full', label: 'کل صفحه', hint: isWeb ? 'کل نمایشگر؛ در پنجره‌ی مرورگر تأیید می‌کنید (پیش‌فرض)' : 'تمام نمایشگر ضبط می‌شود (پیش‌فرض)' },
        { value: 'region', label: 'انتخاب محدوده', hint: isWeb ? 'بعد از شروع، روی پیش‌نمایش با ماوس کادر بکشید' : 'با ماوس یک کادر روی صفحه بکشید' },
      ],
      value: s.mode,
      onChange: (v) => {
        s.mode = v;
        syncMode();
        if (v === 'region' && !isWeb && !validRegion()) pickRegion();
      },
    });
    const audioOpts = [{ value: 'none', label: 'بدون صدا' }, { value: 'system', label: 'صدای سیستم' }, { value: 'mic', label: 'میکروفون' }, { value: 'both', label: 'هر دو' }]
      .filter((o) => caps.systemAudio || (o.value !== 'system' && o.value !== 'both'));
    if (!audioOpts.some((o) => o.value === s.audio)) s.audio = 'none';
    choice($('#rec-audio'), { options: audioOpts, value: s.audio, onChange: (v) => { s.audio = v; syncAudioNote(); } });
    const fpsSel = $('#rec-fps');
    fillSelect(fpsSel, [{ value: 30, label: '30 fps' }, { value: 60, label: '60 fps (روان)' }, { value: 15, label: '15 fps' }], s.fps);
    fpsSel.addEventListener('change', () => { s.fps = Number(fpsSel.value); });
    const qSel = $('#rec-quality');
    fillSelect(qSel, [{ value: 'high', label: 'بالا' }, { value: 'medium', label: 'متوسط (حجم کمتر)' }], s.quality);
    qSel.addEventListener('change', () => { s.quality = qSel.value; });
    const hide = $('#rec-hide');
    hide.checked = !!s.hide;
    hide.addEventListener('change', () => { s.hide = hide.checked; });
    $('#rec-hide-field').hidden = !caps.hideApp;
    const cd = $('#rec-countdown');
    cd.checked = !!s.countdown;
    cd.addEventListener('change', () => { s.countdown = cd.checked; });

    function syncAudioNote() {
      const n = $('#rec-audio-note');
      n.hidden = !(isWeb && (s.audio === 'system' || s.audio === 'both'));
      n.textContent = 'در پنجره‌ی انتخاب مرورگر، گزینه‌ی «اشتراک‌گذاری صدای سیستم» را هم روشن کنید.';
    }

    const dispSel = $('#rec-display');
    dispSel.addEventListener('change', () => { s.displayId = dispSel.value; });
    const dispName = (d) => (d.primary ? 'نمایشگر اصلی' : `نمایشگر ${displays.indexOf(d) + 1}`);
    async function loadDisplays() {
      if (isWeb || !api.displays) return;
      displays = await api.displays();
      const def = displays.find((d) => d.id === String(s.displayId)) || displays.find((d) => d.primary) || displays[0];
      fillSelect(dispSel, displays.map((d) => ({ value: d.id, label: `${dispName(d)} — ${d.pixels.w}×${d.pixels.h}` })), def ? def.id : '');
      s.displayId = dispSel.value || null;
      syncMode();
    }
    const displayById = (id) => displays.find((d) => d.id === String(id)) || null;
    const validRegion = () => !!(s.region && s.region.w > 0 && s.region.h > 0 && displayById(s.region.displayId));

    function syncMode() {
      const region = s.mode === 'region';
      $('#rec-region-row').hidden = !region;
      $('#rec-display-field').hidden = isWeb || region || displays.length < 2;
      const txt = $('#rec-region-text');
      const btn = $('#rec-region-pick');
      btn.hidden = isWeb;
      if (isWeb) txt.textContent = 'بعد از شروع ضبط، محدوده را روی پیش‌نمایش انتخاب می‌کنید.';
      else if (validRegion()) {
        const d = displayById(s.region.displayId);
        const w = Math.round((s.region.w * d.pixels.w) / 2) * 2;
        const hh = Math.round((s.region.h * d.pixels.h) / 2) * 2;
        txt.textContent = `${w}×${hh} پیکسل${displays.length > 1 ? ` · ${dispName(d)}` : ''}`;
        btn.textContent = 'تغییر محدوده';
      } else {
        txt.textContent = 'هنوز محدوده‌ای انتخاب نشده';
        btn.textContent = 'انتخاب با ماوس';
      }
    }

    async function pickRegion() {
      if (isWeb) return false;
      const r = await api.selectRegion({ displayId: s.region ? s.region.displayId : s.displayId, theme: document.documentElement.dataset.theme });
      if (!r) return false;
      if (!displays.length) await loadDisplays();
      s.region = { ...r.rect, displayId: r.displayId };
      if (s.mode !== 'region') { s.mode = 'region'; modeC.set('region'); }
      syncMode();
      return true;
    }
    $('#rec-region-pick').addEventListener('click', pickRegion);

    // where recordings go
    const outPath = h('div', { class: 'outdir-path', dir: 'ltr' });
    const outBtn = h('button', {
      class: 'btn sm', type: 'button', id: 'rec-out-change', onclick: async () => {
        const d = await api.openFolder();
        if (d && (await api.recSetDir(d))) setRecDir(d);
      },
    }, icon('folder'), 'تغییر…');
    $('#rec-outdir').replaceChildren(outPath, outBtn);
    function setRecDir(d) {
      recDir = d;
      outPath.textContent = d;
      outPath.title = d;
      outPath.classList.add('custom');
    }
    if (isWeb) {
      outBtn.hidden = true;
      outPath.textContent = caps.saveDialog ? 'پس از پایان ضبط انتخاب می‌کنید' : 'پوشه‌ی دانلودهای مرورگر';
      $('#rec-out-note').textContent = caps.saveDialog
        ? 'پس از پایان ضبط، پنجره‌ی ذخیره باز می‌شود تا نام و محل فایل را انتخاب کنید.'
        : 'پس از پایان ضبط، نام فایل از شما پرسیده می‌شود و در دانلودها ذخیره می‌شود.';
    } else api.recDir().then((r) => setRecDir(r.dir));

    /* ---------------------------------------------------------------- state */
    const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
    const clock = (sec) => {
      const t = Math.floor(sec);
      const p = (n) => String(n).padStart(2, '0');
      return t >= 3600 ? `${Math.floor(t / 3600)}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}` : `${p(Math.floor(t / 60))}:${p(t % 60)}`;
    };
    function setState(next) {
      state = next;
      document.body.dataset.rec = next;
      const live = ['countdown', 'recording', 'paused'].includes(next);
      nav.classList.toggle('recording', live);
      startBtn.hidden = live;
      startBtn.disabled = next !== 'idle';
      startBtn.querySelector('span').textContent = next === 'starting' ? 'در حال آماده‌سازی…' : next === 'saving' ? 'در حال ذخیره…' : 'شروع ضبط';
      pauseBtn.hidden = !live;
      pauseBtn.disabled = next === 'countdown';
      stopBtn.hidden = !live;
      stopBtn.querySelector('span').textContent = next === 'countdown' ? 'لغو' : 'پایان و ذخیره';
      pauseBtn.querySelector('span').textContent = next === 'paused' ? 'ادامه' : 'توقف موقت';
      pauseBtn.querySelector('i').innerHTML = UI.ICONS[next === 'paused' ? 'play' : 'pause'];
      $('#rec-badge').hidden = !(next === 'recording' || next === 'paused');
      $('#rec-badge').classList.toggle('paused', next === 'paused');
      $('#rec-state').textContent = next === 'paused' ? 'متوقف موقت' : 'در حال ضبط';
      $('#page-record .panel').classList.toggle('locked', next !== 'idle');
      view.hidden = !(ses && ses.v);
      $('#rec-empty').hidden = !view.hidden;
      $('#rec-tip').textContent = next === 'recording' || next === 'paused'
        ? (isWeb ? 'برای پایان، «پایان و ذخیره» را بزنید یا در مرورگر «توقف اشتراک‌گذاری» را انتخاب کنید.' : 'برای پایان از همین دکمه یا نوار کوچک بالای صفحه استفاده کنید.')
        : '';
    }

    const elapsed = () => {
      if (!ses || !ses.t0) return 0;
      const pausedNow = ses.pausedAt ? performance.now() - ses.pausedAt : 0;
      return Math.max(0, (performance.now() - ses.t0 - ses.pausedMs - pausedNow) / 1000);
    };
    function tick() {
      if (!ses) return;
      const time = clock(elapsed());
      $('#rec-timer').textContent = time;
      if (!isWeb) api.recStatus({ state, time });
    }

    /* -------------------------------------------------------------- capture */
    const MIMES_AV = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const MIMES_V = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const pickMime = (audio) => (audio ? MIMES_AV : MIMES_V).find((m) => MediaRecorder.isTypeSupported(m)) || '';

    function cleanup() {
      if (!ses) return;
      clearInterval(ses.timer);
      for (const st of [ses.display, ses.mic]) if (st) st.getTracks().forEach((t) => t.stop());
      if (ses.mix) ses.mix.close().catch(() => {});
      preview.srcObject = null;
    }

    function paintArea() {
      const c = ses && ses.crop;
      area.hidden = !c;
      if (c) Object.assign(area.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
      const st = ses && ses.v && ses.v.getSettings();
      if (st && st.width && st.height) view.style.aspectRatio = `${st.width} / ${st.height}`;
    }

    /** Ask for the display's native pixel size (Chromium otherwise may downscale/letterbox). */
    function nativeSize(id) {
      const d = displayById(id) || displays.find((x) => x.primary);
      return d ? { width: { ideal: d.pixels.w, max: d.pixels.w }, height: { ideal: d.pixels.h, max: d.pixels.h } } : {};
    }
    /**
     * Map a selection (ratios of the display) onto the captured frame. If the capturer letterboxed
     * the screen into a frame with another aspect ratio, crop to the real picture area.
     */
    function fitCrop(r, st, d) {
      if (!d || !st || !st.width || !st.height) return r;
      const full = r || { x: 0, y: 0, w: 1, h: 1 };
      const fa = st.width / st.height;
      const da = d.pixels.w / d.pixels.h;
      if (Math.abs(fa - da) < 0.01) return r;
      const k = Math.min(st.width / d.pixels.w, st.height / d.pixels.h);
      const cw = d.pixels.w * k;
      const ch = d.pixels.h * k;
      const ox = (st.width - cw) / 2;
      const oy = (st.height - ch) / 2;
      return { x: (ox + full.x * cw) / st.width, y: (oy + full.y * ch) / st.height, w: (full.w * cw) / st.width, h: (full.h * ch) / st.height };
    }

    /** Web: choose the region on the live preview once the browser shares the screen. */
    function webPickRegion(track) {
      const st = track.getSettings();
      const vid = h('video', { playsinline: true, autoplay: true });
      vid.muted = true;
      vid.srcObject = new MediaStream([track]);
      vid.play().catch(() => {});
      const stage = h('div', { class: 'pick-stage', dir: 'ltr' }, vid);
      stage.style.aspectRatio = st.width && st.height ? `${st.width} / ${st.height}` : '16 / 9';
      const last = s.region && !s.region.displayId ? s.region : null;
      let sel = null;
      let okBtn = null;
      return SaveAsk.modal({
        title: 'محدوده‌ی ضبط را انتخاب کنید',
        sub: 'روی تصویر با ماوس یا انگشت یک کادر بکشید؛ بعد می‌توانید آن را جابه‌جا یا اندازه‌اش را عوض کنید.',
        cls: 'wide',
        body: () => {
          sel = RegionSelect.attach(stage, {
            pixels: () => ({ w: st.width || stage.clientWidth, h: st.height || stage.clientHeight }),
            initial: last,
            onChange: (r) => { if (okBtn) okBtn.disabled = !r; },
          });
          return [stage];
        },
        actions: (close) => [
          (okBtn = h('button', { class: 'btn primary', type: 'button', id: 'rec-pick-ok', disabled: !last, onclick: () => close(sel.value) }, icon('record'), 'ضبط این محدوده')),
          h('button', { class: 'btn', type: 'button', text: 'کل صفحه', onclick: () => close({ x: 0, y: 0, w: 1, h: 1 }) }),
          h('button', { class: 'btn ghost', type: 'button', text: 'انصراف', onclick: () => close(null) }),
        ],
      }).then((r) => {
        vid.srcObject = null;
        if (r && (r.w < 0.999 || r.h < 0.999)) s.region = { x: r.x, y: r.y, w: r.w, h: r.h };
        return r;
      });
    }

    async function countdown(n) {
      setState('countdown');
      const el = $('#rec-count');
      el.hidden = false;
      for (let i = n; i > 0; i--) {
        if (!ses || ses.aborted) break;
        el.textContent = fa(i);
        if (!isWeb) api.recStatus({ state: 'countdown', n: i });
        await new Promise((r) => setTimeout(r, 1000));
      }
      el.hidden = true;
    }

    async function start() {
      if (state !== 'idle') return;
      setState('starting');
      try {
        if (!isWeb && s.mode === 'region' && !validRegion() && !(await pickRegion())) return setState('idle');
        const wantSys = !!caps.systemAudio && (s.audio === 'system' || s.audio === 'both');
        const wantMic = s.audio === 'mic' || s.audio === 'both';
        const fps = Number(s.fps) || 30;
        const displayId = !isWeb && s.mode === 'region' ? s.region.displayId : s.displayId;
        if (!isWeb) await api.recPrepare({ displayId, systemAudio: wantSys });
        const display = await navigator.mediaDevices.getDisplayMedia(isWeb
          ? { video: { displaySurface: 'monitor', frameRate: { ideal: fps, max: fps } }, audio: wantSys, systemAudio: wantSys ? 'include' : 'exclude', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'include' }
          : { video: { frameRate: { ideal: fps, max: fps }, ...nativeSize(displayId) }, audio: wantSys });
        ses = { display, displayId, fps, chain: Promise.resolve(), pausedMs: 0 };
        const v = display.getVideoTracks()[0];
        try { v.contentHint = 'detail'; } catch { /* optional */ }
        ses.v = v;
        if (wantMic) {
          try {
            ses.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
          } catch {
            toast('دسترسی به میکروفون داده نشد؛ ضبط بدون میکروفون انجام می‌شود.', 'error', 4500);
          }
        }
        if (wantSys && !display.getAudioTracks().length) toast('صدای سیستم به اشتراک گذاشته نشد؛ ویدیو بدون صدای سیستم ضبط می‌شود.', 'error', 4500);
        const tracks = [...display.getAudioTracks(), ...(ses.mic ? ses.mic.getAudioTracks() : [])];
        let aTrack = tracks[0] || null;
        if (tracks.length > 1) {
          // system + microphone -> one mixed track
          ses.mix = new AudioContext({ sampleRate: 48000 });
          const dest = ses.mix.createMediaStreamDestination();
          for (const t of tracks) ses.mix.createMediaStreamSource(new MediaStream([t])).connect(dest);
          aTrack = dest.stream.getAudioTracks()[0];
        }
        ses.aTrack = aTrack;
        preview.srcObject = new MediaStream([v]);
        preview.play().catch(() => {});
        v.addEventListener('ended', () => stop());
        setState('starting');

        if (s.mode === 'region') {
          if (isWeb) {
            const r = await webPickRegion(v);
            if (!r || !ses) {
              cleanup();
              ses = null;
              return setState('idle');
            }
            ses.crop = r.w < 0.999 || r.h < 0.999 ? r : null;
          } else ses.crop = { x: s.region.x, y: s.region.y, w: s.region.w, h: s.region.h };
        }
        if (!isWeb) ses.crop = fitCrop(ses.crop, v.getSettings(), displayById(displayId));
        paintArea();
        if (!isWeb) await api.recStarted({ displayId, region: ses.crop || null, hideApp: !!(s.hide && caps.hideApp) });
        if (s.countdown) await countdown(3);
        if (!ses || ses.aborted) return;
        await begin();
      } catch (e) {
        cleanup();
        ses = null;
        if (!isWeb) api.recStopped();
        setState('idle');
        if (e && e.name === 'NotAllowedError') toast('اجازه‌ی ضبط صفحه داده نشد.', 'error');
        else toast(`شروع ضبط ممکن نشد: ${(e && e.message) || e}`, 'error', 5000);
      }
    }

    async function begin() {
      const st = ses.v.getSettings();
      const px = (st.width || 1920) * (st.height || 1080);
      const bpp = s.quality === 'medium' ? 0.06 : 0.12;
      const vbps = Math.round(Math.min(40e6, Math.max(2.5e6, px * ses.fps * bpp)));
      const stream = new MediaStream([ses.v, ...(ses.aTrack ? [ses.aTrack] : [])]);
      const mimeType = pickMime(!!ses.aTrack);
      ses.mime = mimeType;
      ses.ext = /mp4/.test(mimeType) ? 'mp4' : 'webm';
      ses.sink = await api.recOpen(ses.ext);
      const cur = ses;
      const rec = new MediaRecorder(stream, { mimeType: mimeType || undefined, videoBitsPerSecond: vbps, audioBitsPerSecond: 192000 });
      cur.rec = rec;
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        const blob = e.data;
        cur.chain = cur.chain
          .then(async () => api.recWrite(cur.sink, isWeb ? blob : new Uint8Array(await blob.arrayBuffer())))
          .catch((err) => { cur.writeError = err; });
      };
      rec.onerror = (e) => { cur.recError = e.error || e; stop(); };
      rec.start(1000);
      cur.t0 = performance.now();
      cur.timer = setInterval(tick, 250);
      setState('recording');
      tick();
    }

    function pause() {
      if (!ses || !ses.rec) return;
      if (state === 'recording') {
        ses.rec.pause();
        ses.pausedAt = performance.now();
        setState('paused');
      } else if (state === 'paused') {
        ses.rec.resume();
        ses.pausedMs += performance.now() - ses.pausedAt;
        ses.pausedAt = 0;
        setState('recording');
      }
      tick();
    }

    async function stop() {
      if (!ses || ses.stopping) return;
      ses.stopping = true;
      if (!ses.rec) { // still preparing / counting down -> cancel
        ses.aborted = true;
        cleanup();
        ses = null;
        $('#rec-count').hidden = true;
        if (!isWeb) await api.recStopped();
        return setState('idle');
      }
      const cur = ses;
      if (cur.pausedAt) { cur.pausedMs += performance.now() - cur.pausedAt; cur.pausedAt = 0; }
      const duration = elapsed();
      const done = new Promise((r) => cur.rec.addEventListener('stop', r, { once: true }));
      if (cur.rec.state !== 'inactive') cur.rec.stop();
      await done;
      clearInterval(cur.timer);
      await cur.chain;
      cleanup();
      ses = null;
      setState('saving');
      if (!isWeb) await api.recStopped();
      const res = await api.recClose(cur.sink);
      if (!res || !res.size || cur.writeError) {
        if (res) await api.recDiscard(res.path);
        setState('idle');
        return toast('ضبط ناموفق بود؛ داده‌ای ثبت نشد.', 'error', 5000);
      }
      try {
        await save(res, duration, cur);
      } finally {
        setState('idle');
      }
    }

    function stamp() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    }

    async function save(res, duration, cur) {
      const name = `ضبط صفحه ${stamp()}`;
      // Desktop always finishes as MP4 (native ffmpeg is fast). The web keeps VP8/VP9 captures as
      // WEBM (lossless remux) unless a crop needs an encode anyway.
      const ext = isWeb && cur.ext === 'webm' && !/h264/.test(cur.mime) && !cur.crop ? 'webm' : 'mp4';
      let out = null;
      for (;;) {
        out = await SaveAsk.file({ key: 'record', dir: recDir, name, ext, title: 'ذخیره‌ی ضبط صفحه' });
        if (out) break;
        const r = await SaveAsk.modal({
          title: 'ضبط هنوز ذخیره نشده',
          body: () => [h('p', { class: 'modal-text', text: `ضبط ${fa(clock(duration))} آماده است. اگر ذخیره نکنید حذف می‌شود.` })],
          actions: (close) => [
            h('button', { class: 'btn primary', type: 'button', id: 'rec-save-again', onclick: () => close('save') }, icon('save'), 'انتخاب محل ذخیره'),
            h('button', { class: 'btn danger', type: 'button', id: 'rec-discard', onclick: () => close('discard') }, icon('trash'), 'حذف ضبط'),
          ],
        });
        if (r === 'discard') {
          await api.recDiscard(res.path);
          return toast('ضبط حذف شد.');
        }
      }
      if (!isWeb) {
        const dir = SaveAsk.dirname(out);
        if (dir && dir !== recDir && (await api.recSetDir(dir))) setRecDir(dir);
      }
      const added = await api.addJobs([{
        kind: 'record', input: res.path, outputPath: out, name, label: ext.toUpperCase(),
        opts: { duration, crop: cur.crop ? { ...cur.crop, unit: 'ratio' } : null, quality: s.quality, container: ext },
      }]);
      if (added.length) {
        toast('ضبط در حال ذخیره است…');
        go('queue');
      } else toast('ذخیره‌ی ضبط ممکن نشد.', 'error');
    }

    startBtn.addEventListener('click', start);
    pauseBtn.addEventListener('click', pause);
    stopBtn.addEventListener('click', stop);
    if (api.onRecCommand) api.onRecCommand((cmd) => (cmd === 'stop' ? stop() : pause()));
    window.addEventListener('beforeunload', (e) => {
      if (ses && ses.rec) { e.preventDefault(); e.returnValue = ''; }
    });

    syncMode();
    syncAudioNote();
    loadDisplays();
    setState('idle');
    return { busy: () => !!ses, start, stop };
  },
};
