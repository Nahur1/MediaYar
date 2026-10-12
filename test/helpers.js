'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Runner } = require('../src/core/runner');
const { JobQueue } = require('../src/core/queue');
const { NodeHost } = require('../src/core/node-host');

const FIX = path.join(__dirname, 'fixtures');
const runner = new Runner({ ffmpeg: process.env.FFMPEG || 'ffmpeg', ffprobe: process.env.FFPROBE || 'ffprobe' });

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `my-test-${name}-`));
  return d;
}

/** Run jobs through the real queue and resolve with final snapshots. */
function runJobs(specs) {
  const q = new JobQueue(new NodeHost(runner));
  return new Promise((resolve) => {
    const finals = new Map();
    let ids = [];
    q.on('update', (j) => {
      if (['done', 'error', 'canceled'].includes(j.status)) finals.set(j.id, j);
      if (ids.length && ids.every((id) => finals.has(id))) resolve(ids.map((id) => finals.get(id)));
    });
    ids = q.add(specs).map((j) => j.id);
  });
}

const vstream = (p) => p.streams.find((s) => s.codec_type === 'video');
const astreams = (p) => p.streams.filter((s) => s.codec_type === 'audio');
const sstreams = (p) => p.streams.filter((s) => s.codec_type === 'subtitle');
const dur = (p) => Number(p.format.duration);

module.exports = { FIX, runner, tmpDir, runJobs, vstream, astreams, sstreams, dur, fx: (n) => path.join(FIX, n) };
