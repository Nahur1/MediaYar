'use strict';
/**
 * Builds the static web app / PWA from the SAME renderer + core used by the desktop app.
 *   node scripts/build-web.js [outDir]        (default: dist/web)
 * Needs esbuild, sharp and @ffmpeg/{ffmpeg,core} resolvable (TOOLS_DIR env or ./node_modules).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'web'));
const TOOLS = process.env.TOOLS_DIR || '/data/tools/node_modules';
const req = (m) => { try { return require(m); } catch { return require(path.join(TOOLS, m)); } };
const modDir = (m) => { try { return path.dirname(require.resolve(`${m}/package.json`)); } catch { return path.join(TOOLS, m); } };
const esbuild = req('esbuild');
const sharp = req('sharp');
const pkg = require(path.join(ROOT, 'package.json'));

const R = path.join(ROOT, 'src', 'renderer');
const W = path.join(ROOT, 'src', 'web');
const APP_SCRIPTS = ['ui.js', 'filelist.js', 'video.js', 'audio.js', 'thumbs.js', 'editor.js', 'save.js', 'region.js', 'record.js', 'queue.js', 'app.js'];

const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });

  // 1. platform adapter (core + engine) -> one bundle
  const plat = await esbuild.build({
    entryPoints: [path.join(W, 'platform.js')], bundle: true, format: 'iife', platform: 'browser',
    target: ['chrome100', 'firefox100', 'safari15'], minify: true, write: false, legalComments: 'none',
    define: { 'process.platform': '"browser"' },
  });
  const platJs = plat.outputFiles[0].contents;

  // 2. shared renderer scripts + web extras -> one minified file
  const src = [...APP_SCRIPTS.map((f) => path.join(R, 'js', f)), path.join(W, 'ui-extras.js')]
    .map((f) => `;/* ${path.basename(f)} */\n${fs.readFileSync(f, 'utf8')}`).join('\n');
  // app.js must run after ui-extras is defined: move it last.
  const ordered = src.replace(/(;\/\* app\.js \*\/[\s\S]*?)(;\/\* ui-extras\.js \*\/[\s\S]*)$/, '$2\n$1');
  const app = await esbuild.transform(ordered, { minify: true, target: ['chrome100', 'firefox100', 'safari15'], legalComments: 'none' });
  const css = await esbuild.transform(fs.readFileSync(path.join(R, 'css', 'app.css'), 'utf8'), { loader: 'css', minify: true });

  const vPlat = hash(platJs); const vApp = hash(app.code); const vCss = hash(css.code);
  fs.writeFileSync(path.join(OUT, 'js', 'platform.js'), platJs);
  fs.writeFileSync(path.join(OUT, 'js', 'app.js'), app.code);
  fs.mkdirSync(path.join(OUT, 'css'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'css', 'app.css'), css.code);
  copy(path.join(R, 'fonts', 'Vazirmatn.woff2'), path.join(OUT, 'fonts', 'Vazirmatn.woff2'));
  copy(path.join(R, 'img', 'logo.svg'), path.join(OUT, 'img', 'logo.svg'));

  // 3. ffmpeg.wasm (class + single-thread core)
  const ffDir = path.join(modDir('@ffmpeg/ffmpeg'), 'dist', 'esm');
  for (const f of fs.readdirSync(ffDir).filter((n) => n.endsWith('.js'))) copy(path.join(ffDir, f), path.join(OUT, 'vendor', 'ffmpeg', f));
  const coreDir = path.join(modDir('@ffmpeg/core'), 'dist', 'esm');
  for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) copy(path.join(coreDir, f), path.join(OUT, 'vendor', 'core', f));

  // 4. icons
  const svg = fs.readFileSync(path.join(ROOT, 'assets', 'logo.svg'));
  const ic = path.join(OUT, 'icons');
  fs.mkdirSync(ic, { recursive: true });
  for (const s of [192, 512]) await sharp(svg, { density: 384 }).resize(s, s).png().toFile(path.join(ic, `icon-${s}.png`));
  await sharp(svg, { density: 384 }).resize(180, 180).flatten({ background: '#FBF9FF' }).png().toFile(path.join(ic, 'apple-touch-icon.png'));
  await sharp(svg, { density: 384 }).resize(32, 32).png().toFile(path.join(ic, 'favicon-32.png'));
  const inner = await sharp(svg, { density: 384 }).resize(360, 360).png().toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: '#7C4DEB' } })
    .composite([{ input: inner, gravity: 'centre' }]).png().toFile(path.join(ic, 'maskable-512.png'));

  // 5. index.html from the desktop page
  let html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
  const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'";
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  html = html.replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
  html = html.replace(/<link rel="stylesheet" href="css\/app.css">/, [
    '<meta name="description" content="تبدیل ویدیو و صوت و ویرایش ساده‌ی ویدیو، کاملاً روی دستگاه شما — بدون آپلود.">',
    '<meta name="theme-color" content="#FBF9FF">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="مدیا یار">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="icon" href="icons/favicon-32.png" sizes="32x32">',
    '<link rel="icon" href="img/logo.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
    '<link rel="preload" href="fonts/Vazirmatn.woff2" as="font" type="font/woff2" crossorigin>',
    `<link rel="stylesheet" href="css/app.css?v=${vCss}">`,
  ].join('\n  '));
  html = html.replace(/(\s*<script src="js\/[^"]+"><\/script>)+/, `\n  <script src="js/platform.js?v=${vPlat}"></script>\n  <script src="js/app.js?v=${vApp}" defer></script>`);
  // Keep the inline theme correct before scripts run (avoids a light flash in dark mode).
  fs.writeFileSync(path.join(OUT, 'index.html'), html);

  // 6. manifest, service worker, hosting helpers
  copy(path.join(W, 'manifest.webmanifest'), path.join(OUT, 'manifest.webmanifest'));
  const shell = ['./', './index.html', `./css/app.css?v=${vCss}`, `./js/platform.js?v=${vPlat}`, `./js/app.js?v=${vApp}`,
    './fonts/Vazirmatn.woff2', './img/logo.svg', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
    ...fs.readdirSync(path.join(OUT, 'vendor', 'ffmpeg')).map((f) => `./vendor/ffmpeg/${f}`)];
  const version = `${pkg.version}-${hash(vPlat + vApp + vCss)}`;
  fs.writeFileSync(path.join(OUT, 'sw.js'), fs.readFileSync(path.join(W, 'sw.js'), 'utf8')
    .replace('__VERSION__', version).replace('__SHELL_FILES__', JSON.stringify(shell, null, 2)));
  fs.writeFileSync(path.join(OUT, '_headers'), [
    '/*', '  X-Content-Type-Options: nosniff', '/vendor/*', '  Cache-Control: public, max-age=31536000, immutable',
    '/sw.js', '  Cache-Control: no-cache', '/index.html', '  Cache-Control: no-cache', '',
  ].join('\n'));
  fs.writeFileSync(path.join(OUT, '.htaccess'), 'AddType application/wasm .wasm\nAddType application/manifest+json .webmanifest\n');

  const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  console.log(`Built ${OUT} (${(size(OUT) / 1048576).toFixed(1)} MB, version ${version})`);
})().catch((e) => { console.error(e); process.exit(1); });
