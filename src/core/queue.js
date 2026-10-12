'use strict';
/**
 * Sequential job queue: probe -> plan -> run passes -> verify -> clean up.
 * Platform-neutral: all I/O goes through a *host* (NodeHost for desktop, WasmHost for the web),
 * so the desktop app and the web app share exactly the same job logic.
 *
 * Host interface:
 *   nameOf(input)                         -> display name
 *   stat(input)                           -> Promise<{size}>
 *   probe(input)                          -> Promise<ffprobe json>
 *   resolveInput?(input)                  -> Promise<string>  path the encoder reads
 *   prepare(job, plan, suffix)            -> Promise<{output, target, ctx}>
 *   run(args, {ctx, duration, signal, onProgress})
 *   finalize(job, ctx)                    -> Promise<number>  output size in bytes
 *   discard(job, ctx), cleanup(ctx)       -> Promise<void>
 *   defer?(fn)                            -> schedule fn asynchronously
 */
const { Emitter } = require('./emitter');
const { planVideo, planAudio, planEdit, planRecord } = require('./planner');
const { AbortError } = require('./errors');

const PLANNERS = { video: planVideo, audio: planAudio, edit: planEdit, record: planRecord };
const PROGRESS_INTERVAL_MS = 120;
const defer = (fn) => setTimeout(fn, 0);

class JobQueue extends Emitter {
  constructor(host) {
    super();
    this.host = host;
    this.jobs = new Map();
    this.order = [];
    this.active = null;
    this.seq = 0;
  }

  snapshot(job) {
    const { controller, plan, ctx, ...rest } = job;
    return { ...rest };
  }

  emitUpdate(job) {
    this.emit('update', this.snapshot(job));
  }

  /** @param {{kind:'video'|'audio'|'edit', input:string, opts:object, outputDir?:string, label?:string}[]} specs */
  add(specs) {
    const added = [];
    for (const s of specs) {
      if (!PLANNERS[s.kind]) throw new Error(`unknown job kind ${s.kind}`);
      const job = {
        id: `j${Date.now().toString(36)}${(++this.seq).toString(36)}`,
        kind: s.kind,
        input: s.input,
        name: s.name || this.host.nameOf(s.input),
        opts: s.opts || {},
        outputDir: s.outputDir || null,
        outputPath: s.outputPath || null, // exact destination chosen in a "Save as" dialog
        tempInput: !!s.tempInput, // input is a temporary file we own (screen recordings)
        label: s.label || '',
        status: 'queued',
        progress: 0,
        speed: 0,
        eta: null,
        output: null,
        outputName: null,
        inputSize: 0,
        outputSize: 0,
        error: null,
        errorDetails: null,
        startedAt: null,
        finishedAt: null,
      };
      this.jobs.set(job.id, job);
      this.order.push(job.id);
      added.push(this.snapshot(job));
      this.emitUpdate(job);
    }
    this.pump();
    return added;
  }

  list() {
    return this.order.map((id) => this.snapshot(this.jobs.get(id)));
  }

  get(id) {
    const j = this.jobs.get(id);
    return j ? this.snapshot(j) : null;
  }

  busy() {
    return this.order.some((id) => ['queued', 'running'].includes(this.jobs.get(id).status));
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'canceled';
      this.emitUpdate(job);
      return true;
    }
    if (job.status === 'running' && job.controller) {
      job.controller.abort();
      return true;
    }
    return false;
  }

  cancelAll() {
    for (const id of this.order) this.cancel(id);
  }

  /** Remove finished / failed / canceled jobs from the list. */
  clearFinished() {
    this.order = this.order.filter((id) => {
      const j = this.jobs.get(id);
      const keep = j.status === 'queued' || j.status === 'running';
      if (!keep) {
        this.jobs.delete(id);
        this.emit('removed', this.snapshot(j));
      }
      return keep;
    });
    return this.list();
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job || !['error', 'canceled'].includes(job.status)) return null;
    return this.add([{ kind: job.kind, input: job.input, name: job.name, opts: job.opts, outputDir: job.outputDir, outputPath: job.outputPath, tempInput: job.tempInput, label: job.label }])[0];
  }

  /** Overall progress of the current batch, for the taskbar. */
  overall() {
    const jobs = this.order.map((id) => this.jobs.get(id));
    const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    if (!pending.length) return -1;
    const batch = jobs.filter((j) => j.status !== 'canceled' && j.status !== 'error' && j.batchDone !== true);
    const sum = batch.reduce((a, j) => a + (j.status === 'done' ? 1 : j.progress), 0);
    return batch.length ? sum / batch.length : 0;
  }

  async pump() {
    if (this.active) return;
    const next = this.order.map((id) => this.jobs.get(id)).find((j) => j.status === 'queued');
    if (!next) {
      for (const j of this.jobs.values()) j.batchDone = true;
      this.emit('idle');
      return;
    }
    this.active = next;
    try {
      await this.execute(next);
    } finally {
      this.active = null;
      (this.host.defer || defer)(() => this.pump());
    }
  }

  async execute(job) {
    const host = this.host;
    job.status = 'running';
    job.startedAt = Date.now();
    job.controller = new AbortController();
    this.emitUpdate(job);
    let ctx = null;
    try {
      job.inputSize = (await host.stat(job.input)).size;
      const probe = await host.probe(job.input);
      if (job.controller.signal.aborted) throw new AbortError();
      const input = host.resolveInput ? await host.resolveInput(job.input) : job.input;
      const plan = PLANNERS[job.kind]({ input, probe, opts: job.opts });
      const suffix = job.kind === 'edit' ? 'edited' : plan.suffix;
      const prep = await host.prepare(job, plan, suffix);
      ctx = prep.ctx;
      job.output = prep.output;
      job.outputName = prep.name || null;
      const passes = plan.build(prep.target);
      let done = 0;
      let lastEmit = 0;
      for (const pass of passes) {
        if (job.controller.signal.aborted) throw new AbortError();
        await host.run(pass.args, {
          ctx,
          duration: plan.duration,
          signal: job.controller.signal,
          onProgress: ({ ratio, speed }) => {
            job.progress = Math.min(0.999, done + ratio * pass.weight);
            job.speed = speed;
            const elapsed = (Date.now() - job.startedAt) / 1000;
            job.eta = job.progress > 0.02 ? Math.max(0, (elapsed / job.progress) * (1 - job.progress)) : null;
            const now = Date.now();
            if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
              lastEmit = now;
              this.emitUpdate(job);
            }
          },
        });
        done += pass.weight;
      }
      const size = await host.finalize(job, ctx);
      if (!size) throw Object.assign(new Error('فایل خروجی خالی است.'), { userFacing: true });
      job.outputSize = size;
      if (job.tempInput && host.releaseInput) await Promise.resolve(host.releaseInput(job.input)).catch(() => {});
      job.status = 'done';
      job.progress = 1;
      job.eta = 0;
    } catch (e) {
      if (job.output) await Promise.resolve(host.discard(job, ctx)).catch(() => {});
      if (e instanceof AbortError || e.name === 'AbortError' || job.controller.signal.aborted) {
        job.status = 'canceled';
      } else {
        job.status = 'error';
        job.error = e.userFacing || e.name === 'FFmpegError' || e.name === 'PlanError' ? e.message : 'خطای غیرمنتظره رخ داد.';
        job.errorDetails = e.details || e.stack || String(e);
      }
      job.output = null;
      job.outputName = null;
    } finally {
      if (ctx) await Promise.resolve(host.cleanup(ctx)).catch(() => {});
      job.finishedAt = Date.now();
      delete job.controller;
      this.emitUpdate(job);
    }
  }
}

module.exports = { JobQueue, PLANNERS };
