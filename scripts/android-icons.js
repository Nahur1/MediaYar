'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const root = path.join(__dirname,'..');
const res = path.join(root,'android','app','src','main','res');
(async () => {
  const svg = fs.readFileSync(path.join(root,'assets','logo.svg'));
  for (const [density,size] of Object.entries({mdpi:48,hdpi:72,xhdpi:96,xxhdpi:144,xxxhdpi:192})) {
    const dir = path.join(res,`mipmap-${density}`);
    fs.mkdirSync(dir,{recursive:true});
    await sharp(svg).resize(size,size).png().toFile(path.join(dir,'ic_launcher.png'));
    const circle = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="white"/></svg>`);
    await sharp(svg).resize(size,size).composite([{input:circle,blend:'dest-in'}]).png().toFile(path.join(dir,'ic_launcher_round.png'));
    const inner = await sharp(svg).resize(size,size).png().toBuffer();
    await sharp({create:{width:Math.round(size*2.25),height:Math.round(size*2.25),channels:4,background:'#edf2fa'}}).composite([{input:inner,gravity:'centre'}]).png().toFile(path.join(dir,'ic_launcher_foreground.png'));
  }
  console.log('Android launcher icons generated');
})().catch(e => {console.error(e);process.exitCode=1;});
