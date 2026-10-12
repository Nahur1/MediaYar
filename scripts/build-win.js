'use strict';
/**
 * Assembles the portable Windows x64 build from Linux:
 *   Electron win32-x64 runtime + app.asar + FFmpeg (shared build) -> MediaYar/
 * Then sets the exe icon/version info (resedit) and zips it.
 * Usage: node scripts/build-win.js <electron-win-dir> <ffmpeg-bin-dir> <out-dir>
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOLS = '/data/tools/node_modules';

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const [electronDir, ffmpegDir, outRoot] = process.argv.slice(2);
const APP_DIR = path.join(outRoot, 'MediaYar');
const EXE = 'MediaYar.exe';

function copyDir(src, dst, filter = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (!filter(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

(async () => {
  const asar = await import(path.join(TOOLS, '@electron/asar', 'lib', 'asar.js'));
  const ResEdit = await import(path.join(TOOLS, 'resedit', 'dist', 'index.js'));
  const PELibrary = await import(path.join(TOOLS, 'pe-library', 'dist', 'index.js'));
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  // 1) Electron runtime (keep only Persian + English UI locales)
  copyDir(electronDir, APP_DIR, (s, e) => {
    if (s.includes(`${path.sep}locales${path.sep}`) && e.isFile()) return ['en-US.pak', 'fa.pak'].includes(e.name);
    return !(e.name === 'default_app.asar');
  });
  fs.renameSync(path.join(APP_DIR, 'electron.exe'), path.join(APP_DIR, EXE));
  fs.renameSync(path.join(APP_DIR, 'LICENSE'), path.join(APP_DIR, 'LICENSE.electron.txt'));

  // 2) App sources -> resources/app.asar
  const stage = path.join(outRoot, '_stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  copyDir(path.join(ROOT, 'src'), path.join(stage, 'src'), (s) => !s.startsWith(path.join(ROOT, 'src', 'web')));
  copyDir(path.join(ROOT, 'assets'), path.join(stage, 'assets'));
  const runtimePkg = { name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main, author: pkg.author, license: pkg.license };
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(runtimePkg, null, 2));
  await asar.createPackage(stage, path.join(APP_DIR, 'resources', 'app.asar'));
  fs.rmSync(stage, { recursive: true, force: true });

  // 3) FFmpeg (ffmpeg.exe + ffprobe.exe + shared DLLs; ffplay not needed)
  const ffOut = path.join(APP_DIR, 'resources', 'ffmpeg');
  fs.mkdirSync(ffOut, { recursive: true });
  for (const f of fs.readdirSync(ffmpegDir)) {
    if (f === 'ffplay.exe') continue;
    fs.copyFileSync(path.join(ffmpegDir, f), path.join(ffOut, f));
  }
  const ffLicense = path.join(ffmpegDir, '..', 'LICENSE.txt');
  if (fs.existsSync(ffLicense)) fs.copyFileSync(ffLicense, path.join(ffOut, 'LICENSE.ffmpeg.txt'));

  // 4) Exe icon + version info
  const exePath = path.join(APP_DIR, EXE);
  const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath));
  const res = PELibrary.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'assets', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const v = pkg.version.split('.').map(Number);
  vi.setFileVersion(v[0], v[1], v[2], 0, 1033);
  vi.setProductVersion(v[0], v[1], v[2], 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'Media Yar - Video, Audio & Screen Recorder',
    ProductName: 'Media Yar',
    CompanyName: 'Media Yar',
    InternalName: 'MediaYar',
    OriginalFilename: EXE,
    LegalCopyright: 'MIT License',
    FileVersion: pkg.version,
    ProductVersion: pkg.version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));

  // 5) Readme
  fs.copyFileSync(path.join(ROOT, 'scripts', 'README-fa.txt'), path.join(outRoot, 'راهنما - README.txt'));
  console.log('Built', APP_DIR);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
