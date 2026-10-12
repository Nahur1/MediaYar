'use strict';
/**
 * Platform-neutral application service used by both the Electron main process and the web app:
 * cached probing, plan previews and the job queue — one implementation, two front-ends.
 */
const M = require('./media');
const { JobQueue, PLANNERS } = require('./queue');
const { userError } = require('./errors');

const CACHE_MAX = 300;

function createService(host) {
  const queue = new JobQueue(host);
  const rawProbe = host.probe.bind(host);
  const cache = new Map(); // input -> { key, probe, size }
  const inflight = new Map(); // input -> Promise (dedupes concurrent probes of one file)

  async function probeCached(input) {
    const st = await host.stat(input);
    const hit = cache.get(input);
    if (hit && hit.key === st.key) return hit;
    if (inflight.has(input)) return inflight.get(input);
    const p = (async () => {
      const probe = await rawProbe(input);
      const entry = { key: st.key, probe, size: st.size };
      cache.set(input, entry);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return entry;
    })().finally(() => inflight.delete(input));
    inflight.set(input, p);
    return p;
  }

  // Jobs re-use the cached probe (re-validated by size/mtime) instead of probing twice.
  host.probe = async (input) => (await probeCached(input)).probe;

  return {
    queue,
    async probe(input) {
      try {
        const { probe, size } = await probeCached(input);
        return { summary: M.summarize(probe, input, size) };
      } catch (e) {
        return userError(e);
      }
    },
    async preview(kind, input, opts) {
      const planner = PLANNERS[kind];
      if (!planner) return { error: 'درخواست نامعتبر' };
      try {
        const { probe } = await probeCached(input);
        const plan = planner({ input, probe, opts: opts || {} });
        return { info: plan.info, ext: plan.ext, duration: plan.duration };
      } catch (e) {
        return userError(e);
      }
    },
    forget(input) { cache.delete(input); },
  };
}

module.exports = { createService };
