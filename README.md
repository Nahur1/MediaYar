# Media Yar (مدیا یار)

One codebase, three targets: **Windows desktop** (Electron + native FFmpeg), **web app / PWA**
(FFmpeg compiled to WebAssembly, everything runs on the user's device), and **Android APK**
(the PWA wrapped with Capacitor or a TWA). Video converter, audio converter, a simple video editor and a screen recorder.
Persian RTL UI, purple/yellow theme, light & dark modes, responsive down to phone screens.

## Architecture — change once, ship everywhere
```
src/core/       platform-neutral engine (pure JS, unit-tested)
  formats.js      container/codec catalog (+ restrict() per engine)
  media.js        probe analysis, scale/crop/bitrate math
  planner.js      user options -> exact ffmpeg arguments (copy vs encode, 2-pass size targeting,
                  screen-recording finalize: crop/remux/encode to a seekable MP4)
  queue.js        job queue; all I/O through a "host"
  service.js      cached probing + plan preview + queue  (used by desktop AND web)
  progress.js, errors.js, emitter.js
  node-host.js, runner.js     desktop host: real files + native ffmpeg processes
src/web/        web host: engine.js (ffmpeg.wasm), wasm-host.js, platform.js (window.api), sw.js, manifest
src/main/       Electron main process + preload (window.api over IPC)
  recorder.js     screen capture source, region overlay, floating control bar, temp-file sink
src/renderer/   the UI — identical for desktop and web; talks only to window.api
```
The UI never knows which platform it runs on except through `window.APP.caps`
(e.g. "show in folder" on desktop, "download/share" on the web). A feature added to the core or the
renderer appears in all targets after a rebuild — no per-platform rewrite.

## Saving & recording
Every export asks where to save (`renderer/js/save.js`): one file -> Save-as with a suggested folder
and name; several -> "next to originals / Downloads" or a chosen folder. Jobs carry `outputPath`
or `outputDir`; hosts write to a temporary sibling and rename at the end (no partial files).
Screen recording (`renderer/js/record.js`): getDisplayMedia + optional mic (mixed via Web Audio) ->
MediaRecorder chunks -> sink (temp file on desktop, Blobs on the web) -> a `record` job in the queue.
Region selection is stored as ratios and cropped by ffmpeg, so it is resolution-independent.

## Commands
    npm run test:unit
    npm test                          # unit + integration (needs ffmpeg/ffprobe on PATH)
    node test/e2e.js                  # desktop UI end-to-end (Linux Electron + X display)
    node scripts/build-web.js         # -> dist/web  (static site / PWA)
    node test/web-e2e.js              # web end-to-end in headless Chromium with real ffmpeg.wasm
    node scripts/serve-web.js dist/web 8080
    node scripts/build-win.js <electron-win32-x64-dir> <ffmpeg-win64-bin-dir> <out-dir>

## Web / PWA / APK
See `WEB-PWA-APK.md`.
