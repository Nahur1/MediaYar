'use strict';
window.AudioPage = {
  init({ cat, go }) {
    const { $, choice, fillSelect, store, toast } = UI;
    const s = store('mediayar.audio', { format: 'mp3', kbps: 192, sampleRate: 0, channels: 0, normalize: false });

    const files = FileList.create({
      list: $('#audio-files'), zone: $('#audio-drop'), kind: 'audio',
      head: $('#audio-list-head'), count: $('#audio-count'), clearBtn: $('#audio-clear'), onChange: update,
    });

    const formats = Object.entries(cat.audioFormats).map(([value, f]) => ({ value, label: f.label }));
    choice($('#audio-format'), { kind: 'chip', options: formats, value: s.format, onChange: (v) => { s.format = v; syncFormat(); } });

    const br = $('#audio-bitrate');
    br.addEventListener('change', () => { s.kbps = Number(br.value); });
    const rate = $('#audio-rate');
    fillSelect(rate, [{ value: 0, label: 'مانند اصلی' }, ...cat.sampleRates.map((r) => ({ value: r, label: `${(r / 1000).toLocaleString('en')} kHz` }))], s.sampleRate);
    rate.addEventListener('change', () => { s.sampleRate = Number(rate.value); });
    choice($('#audio-channels'), {
      options: [{ value: 0, label: 'مانند اصلی' }, { value: 2, label: 'استریو' }, { value: 1, label: 'مونو' }],
      value: s.channels, onChange: (v) => { s.channels = Number(v); },
    });
    const norm = $('#audio-normalize');
    norm.checked = !!s.normalize;
    norm.addEventListener('change', () => { s.normalize = norm.checked; });

    function syncFormat() {
      const f = cat.audioFormats[s.format] || cat.audioFormats.mp3;
      if (f.lossless || f.fixed) {
        fillSelect(br, [{ value: 0, label: f.fixed ? '12.2 kbps (ثابت)' : 'بدون افت (Lossless)' }], 0);
        br.disabled = true;
        rate.disabled = !!f.fixed;
      } else {
        const list = cat.audioBitrates.map((k) => ({ value: k, label: `${k} kbps${k === f.defaultKbps ? ' · پیشنهادی' : ''}` }));
        fillSelect(br, list, cat.audioBitrates.includes(Number(s.kbps)) ? s.kbps : f.defaultKbps);
        br.disabled = false;
        rate.disabled = false;
      }
      update();
    }

    function update() {
      const n = files.ready.length;
      const btn = $('#audio-start');
      btn.disabled = n === 0;
      btn.querySelector('span').textContent = n ? `تبدیل ${n} فایل به ${cat.audioFormats[s.format].label}` : 'شروع تبدیل';
    }

    $('#audio-start').addEventListener('click', async () => {
      const ready = files.ready;
      if (!ready.length) return;
      const f = cat.audioFormats[s.format];
      const opts = {
        format: s.format,
        kbps: f.lossless || f.fixed ? null : Number(br.value),
        sampleRate: Number(s.sampleRate) || null,
        channels: Number(s.channels) || null,
        normalize: !!s.normalize,
      };
      const dest = await SaveAsk.forJobs({ key: 'audio', items: ready, ext: f.ext, title: ready.length > 1 ? 'خروجی‌ها کجا ذخیره شوند؟' : 'ذخیره‌ی فایل تبدیل‌شده' });
      if (!dest) return;
      const added = await window.api.addJobs(ready.map((x, i) => ({ kind: 'audio', input: x.path, opts, ...dest[i], label: f.label })));
      if (added.length) {
        toast(`${added.length} فایل به صف تبدیل اضافه شد`);
        files.clear();
        go('queue');
      } else toast('فایلی اضافه نشد؛ مسیر فایل‌ها را بررسی کنید.', 'error');
    });

    syncFormat();
    return { addFiles: files.add };
  },
};
