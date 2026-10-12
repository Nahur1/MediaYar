'use strict';
/**
 * Tiny static server for the built web app (dev / testing).
 *   node scripts/serve-web.js [dir] [port] [--no-isolation]
 * Sends COOP/COEP so the multi-threaded FFmpeg core can be used
 * (the service worker adds the same headers on hosts that can't).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const root = path.resolve(args[0] || path.join(__dirname, '..', 'dist', 'web'));
const port = Number(args[1] || 8080);
const isolate = !process.argv.includes('--no-isolation');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' };
    if (isolate) Object.assign(headers, { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, '127.0.0.1', () => console.log(`Serving ${root} on http://127.0.0.1:${port} (isolation ${isolate ? 'on' : 'off'})`));
