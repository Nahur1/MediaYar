'use strict';
/** Desktop (Node/Electron) host for JobQueue: real files + native ffmpeg processes. */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

/** "C:\v\movie.mkv" + mp4 -> "C:\v\movie.mp4", never overwriting an existing file. */
function outputPathFor(input, ext, { outputDir, suffix } = {}) {
  const dir = outputDir || path.dirname(input);
  const base = path.basename(input, path.extname(input));
  const srcExt = path.extname(input).slice(1).toLowerCase();
  let stem = base;
  if (suffix) stem += `_${suffix}`;
  else if (srcExt === ext.toLowerCase() && path.resolve(dir) === path.resolve(path.dirname(input))) stem += '_converted';
  let candidate = path.join(dir, `${stem}.${ext}`);
  for (let i = 2; fs.existsSync(candidate) || samePath(candidate, input); i++) {
    candidate = path.join(dir, `${stem} (${i}).${ext}`);
  }
  return candidate;
}

function samePath(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

class NodeHost {
  /** @param {import('./runner').Runner} runner */
  constructor(runner) {
    this.runner = runner;
  }

  nameOf(input) { return path.basename(input); }

  async stat(input) {
    const st = await fsp.stat(input);
    if (!st.isFile()) throw Object.assign(new Error('این مسیر یک فایل نیست.'), { userFacing: true });
    return { size: st.size, key: `${st.size}:${st.mtimeMs}` };
  }

  probe(input) { return this.runner.probe(input); }

  async prepare(job, plan, suffix) {
    let output;
    if (job.outputPath) {
      // User picked the exact file in a Save dialog (overwrite already confirmed there).
      output = path.extname(job.outputPath).slice(1).toLowerCase() === plan.ext ? job.outputPath : `${job.outputPath}.${plan.ext}`;
      if (samePath(output, job.input)) throw Object.assign(new Error('فایل خروجی نمی‌تواند همان فایل اصلی باشد؛ نام دیگری انتخاب کنید.'), { userFacing: true });
      await fsp.mkdir(path.dirname(output), { recursive: true });
    } else {
      if (job.outputDir) await fsp.mkdir(job.outputDir, { recursive: true });
      output = outputPathFor(job.input, plan.ext, { outputDir: job.outputDir, suffix });
    }
    // Encode into a temporary sibling and rename at the end: a failed or canceled job never
    // leaves a half-written file behind and never destroys a file the user chose to replace.
    const target = path.join(path.dirname(output), `.${path.basename(output, `.${plan.ext}`)}.mediayar-part.${plan.ext}`);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mediayar-'));
    return { output, target, name: path.basename(output), ctx: { tmp, target } };
  }

  run(args, { ctx, ...o }) { return this.runner.run(args, { ...o, cwd: ctx && ctx.tmp }); }

  async finalize(job, ctx) {
    await fsp.rename(ctx.target, job.output);
    return (await fsp.stat(job.output)).size;
  }

  async discard(job, ctx) { if (ctx && ctx.target) await fsp.rm(ctx.target, { force: true }); }

  async cleanup(ctx) { if (ctx && ctx.tmp) await fsp.rm(ctx.tmp, { recursive: true, force: true }); }

  async releaseInput(input) { await fsp.rm(input, { force: true }); }

  defer(fn) { setImmediate(fn); }
}

module.exports = { NodeHost, outputPathFor };
