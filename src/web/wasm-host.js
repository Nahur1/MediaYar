'use strict';
/** Browser host for the shared JobQueue: Files in, Blobs out, ffmpeg.wasm in between. */

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpg: 'video/mpeg', ts: 'video/mp2t', '3gp': 'video/3gpp', ogv: 'video/ogg', gif: 'image/gif',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
  wma: 'audio/x-ms-wma', aiff: 'audio/aiff', ac3: 'audio/ac3', amr: 'audio/amr',
};

const stemOf = (name) => name.replace(/\.[^.]+$/, '') || 'output';
const extOf = (name) => (/\.([^.]+)$/.exec(name) || [])[1] || '';

class WasmHost {
  /**
   * @param {{files:Map<string,File>, engine:import('./engine').Engine, probeEngine:import('./engine').Engine,
   *          outputs:Map<string,{blob:Blob,name:string}>, deliver:(job, out)=>Promise<void>}} o
   */
  constructor(o) {
    Object.assign(this, o);
    this.taken = new Set(); // output names produced this session
  }

  file(id) {
    const f = this.files.get(id);
    if (!f) throw Object.assign(new Error('فایل ورودی دیگر در دسترس نیست؛ دوباره آن را انتخاب کنید.'), { userFacing: true });
    return f;
  }

  nameOf(id) { return (this.files.get(id) || { name: id.split('/').pop() }).name; }

  async stat(id) {
    const f = this.file(id);
    return { size: f.size, key: `${f.size}:${f.lastModified}` };
  }

  probe(id) {
    const f = this.file(id);
    const e = this.probeEngine;
    return e.task(async () => {
      const p = await e.mount(id, f);
      const out = `/o/probe-${Date.now().toString(36)}.json`;
      await e.exec(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p, '-o', out], { probe: true })
        .catch((err) => {
          throw Object.assign(new Error('فایل قابل خواندن نیست یا فرمت آن پشتیبانی نمی‌شود.'), {
            userFacing: true, details: err.details || String((err && (err.stack || err.message)) || err),
          });
        });
      let json = {};
      try {
        json = JSON.parse(new TextDecoder().decode(await e.readFile(out)));
      } catch { /* unreadable -> handled below */ } finally {
        await e.remove(out);
      }
      if (!json.streams || !json.streams.length) {
        throw Object.assign(new Error('فایل قابل خواندن نیست یا فرمت آن پشتیبانی نمی‌شود.'), { userFacing: true });
      }
      return json;
    });
  }

  resolveInput(id) {
    return this.engine.task(() => this.engine.mount(id, this.file(id)));
  }

  uniqueName(input, ext, suffix) {
    const src = this.nameOf(input);
    let stem = stemOf(src);
    if (suffix) stem += `_${suffix}`;
    else if (extOf(src).toLowerCase() === ext.toLowerCase()) stem += '_converted';
    let name = `${stem}.${ext}`;
    for (let i = 2; this.taken.has(name.toLowerCase()); i++) name = `${stem} (${i}).${ext}`;
    this.taken.add(name.toLowerCase());
    return name;
  }

  async prepare(job, plan, suffix) {
    const t = job.outputPath && this.targets && this.targets.get(job.outputPath);
    // name chosen in a save dialog keeps the real container extension
    const name = t
      ? (extOf(t.name).toLowerCase() === plan.ext ? t.name : `${stemOf(t.name)}.${plan.ext}`)
      : this.uniqueName(job.input, plan.ext, suffix);
    const target = `/o/${job.id}.${plan.ext}`;
    return { output: `${job.id}/${name}`, name, target, ctx: { target, ext: plan.ext, name } };
  }

  run(args, { ctx, ...o }) {
    return this.engine.task(() => this.engine.exec(args, o));
  }

  async finalize(job, ctx) {
    const data = await this.engine.task(() => this.engine.readFile(ctx.target));
    await this.engine.task(() => this.engine.remove(ctx.target));
    const blob = new Blob([data], { type: MIME[ctx.ext] || 'application/octet-stream' });
    const out = { blob, name: ctx.name };
    this.outputs.set(job.output, out);
    await this.deliver(job, out);
    return blob.size;
  }

  async discard(job, ctx) {
    if (job.output) this.outputs.delete(job.output);
    if (ctx && ctx.name) this.taken.delete(ctx.name.toLowerCase());
    if (ctx && ctx.target) await this.engine.task(() => this.engine.remove(ctx.target));
  }

  cleanup() {
    return this.engine.task(() => this.engine.sweep());
  }

  defer(fn) { setTimeout(fn, 0); }
}

module.exports = { WasmHost, MIME };
