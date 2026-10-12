/* Media Yar service worker: offline app shell + cached FFmpeg core (works fully offline after first visit). */
const VERSION = '__VERSION__';
const SHELL = `mediayar-shell-${VERSION}`;
const CORE = 'mediayar-core-v0.12.10'; // ~30 MB, only re-downloaded when the core version changes
const SHELL_FILES = __SHELL_FILES__;

const CORE_FILES = ['./vendor/core/ffmpeg-core.js', './vendor/core/ffmpeg-core.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await caches.open(SHELL).then((c) => c.addAll(SHELL_FILES));
    // The engine is cached up-front so the app works offline right after the first visit
    // (usually served from the HTTP cache the page just filled). Non-fatal if it fails.
    const core = await caches.open(CORE);
    if (!(await core.match(CORE_FILES[1]))) await core.addAll(CORE_FILES).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== CORE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isCore = url.pathname.includes('/vendor/core/');
  e.respondWith((async () => {
    const cacheName = isCore ? CORE : SHELL;
    const cache = await caches.open(cacheName);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok && (isCore || url.pathname.startsWith(new URL('./', self.registration.scope).pathname))) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      if (e.request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
