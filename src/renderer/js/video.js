'use strict';
window.VideoPage = {
  init({ cat, go }) {
    const { $, choice, fillSelect, store, toast } = UI;
    const s = store('mediayar.video', { format: 'mp4', codec: 'h264', quality: 'high', resolution: 'original', speed: 'balanced', smartCopy: true });

    const files = FileList.create({
      list: $('#video-files'), zone: $('#video-drop'), kind: 'video',
      head: $('#video-list-head'), count: $('#video-count'), clearBtn: $('#video-clear'), onChange: update,
    });

    const formats = Object.entries(cat.videoFormats).map(([value, f]) => ({ value, label: f.label }));
    const format = choice($('#video-format'), { kind: 'chip', options: formats, value: s.format, onChange: (v) => { s.format = v; syncFormat(); } });
    const codec = choice($('#video-codec'), { options: [], value: s.codec, onChange: (v) => { s.codec = v; } });
    choice($('#video-quality'), {
      options: [{ value: 'high', label: 'بالا' }, { value: 'medium', label: 'متوسط' }, { value: 'low', label: 'کم‌حجم' }],
      value: s.quality, onChange: (v) => { s.quality = v; },
    });

    const res = $('#video-res');
    fillSelect(res, [{ value: 'original', label: 'مانند اصلی' }, ...cat.resolutions.map((r) => ({ value: r, label: { 2160: '2160p (4K)', 1440: '1440p (2K)', 1080: '1080p (Full HD)', 720: '720p (HD)' }[r] || `${r}p` }))], s.resolution);
    res.addEventListener('change', () => { s.resolution = res.value; update(); });

    const speed = $('#video-speed');
    fillSelect(speed, [{ value: 'fast', label: 'سریع' }, { value: 'balanced', label: 'متعادل' }, { value: 'best', label: 'بهترین فشرده‌سازی' }], s.speed);
    speed.addEventListener('change', () => { s.speed = speed.value; });

    const smart = $('#video-smart');
    smart.checked = !!s.smartCopy;
    smart.addEventListener('change', () => { s.smartCopy = smart.checked; });


    function syncFormat() {
      const f = cat.videoFormats[s.format] || cat.videoFormats.mp4;
      const codecs = f.codecs.map((c) => ({ value: c, label: cat.videoCodecs[c].label }));
      codec.setOptions(codecs, f.codecs.includes(s.codec) ? s.codec : f.codecs[0]);
      $('#video-codec-field').hidden = codecs.length < 2;
      $('#video-smart-field').hidden = f.gif;
      $('#video-speed-field').style.visibility = f.gif ? 'hidden' : '';
      update();
    }

    function update() {
      const n = files.ready.length;
      const btn = $('#video-start');
      btn.disabled = n === 0;
      const label = cat.videoFormats[s.format].label;
      btn.querySelector('span').textContent = n ? `تبدیل ${n} فایل به ${label}` : 'شروع تبدیل';
    }

    $('#video-start').addEventListener('click', async () => {
      const ready = files.ready;
      if (!ready.length) return;
      const f = cat.videoFormats[s.format];
      const opts = {
        format: s.format,
        codec: f.codecs.includes(codec.value) ? codec.value : f.codecs[0],
        quality: s.quality,
        resolution: s.resolution === 'original' ? null : Number(s.resolution),
        speed: s.speed,
        smartCopy: !!s.smartCopy,
      };
      const dest = await SaveAsk.forJobs({ key: 'video', items: ready, ext: f.ext, title: ready.length > 1 ? 'خروجی‌ها کجا ذخیره شوند؟' : 'ذخیره‌ی فایل تبدیل‌شده' });
      if (!dest) return;
      const added = await window.api.addJobs(ready.map((x, i) => ({ kind: 'video', input: x.path, opts, ...dest[i], label: f.label })));
      if (added.length) {
        toast(`${added.length} فایل به صف تبدیل اضافه شد`);
        files.clear();
        go('queue');
      } else toast('فایلی اضافه نشد؛ مسیر فایل‌ها را بررسی کنید.', 'error');
    });

    format.set(s.format);
    syncFormat();
    return { addFiles: files.add };
  },
};
