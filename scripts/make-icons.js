'use strict';
// Renders assets/icon.png and a multi-size assets/icon.ico from the SVG logo.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo.svg'));
(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()));
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), await sharp(svg, { density: 384 }).resize(512, 512).png().toBuffer());
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const b = dir.subarray(i * 16);
    b.writeUInt8(s >= 256 ? 0 : s, 0); b.writeUInt8(s >= 256 ? 0 : s, 1);
    b.writeUInt8(0, 2); b.writeUInt8(0, 3); b.writeUInt16LE(1, 4); b.writeUInt16LE(32, 6);
    b.writeUInt32LE(pngs[i].length, 8); b.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'), Buffer.concat([header, dir, ...pngs]));
  console.log('icons written');
})();
