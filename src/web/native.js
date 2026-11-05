'use strict';
const { Capacitor } = require('@capacitor/core');
const { Filesystem, Directory } = require('@capacitor/filesystem');
const { Share } = require('@capacitor/share');
const isAndroid = Capacitor.getPlatform() === 'android';

async function cacheOutput(out) {
  if (out.nativeUri) return out.nativeUri;
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(out.blob);
  });
  const safe = out.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  const result = await Filesystem.writeFile({
    path: `exports/${Date.now()}-${safe}`, data, directory: Directory.Cache, recursive: true,
  });
  out.nativeUri = result.uri;
  return result.uri;
}

async function shareOutput(out) {
  const uri = await cacheOutput(out);
  await Share.share({ title: out.name, files: [uri], dialogTitle: 'ذخیره یا اشتراک خروجی' });
  return true;
}
module.exports = { isAndroid, cacheOutput, shareOutput };
