'use strict';
// Reuse the existing Windows runtime while packaging the current application.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname,'..');
(async () => {
  const { createPackage } = await import('@electron/asar');
  const runtime = path.resolve(process.argv[2] || path.join(root,'builds','win64'));
  const destination = path.join(root,'builds','release','MediaYar');
  const stage = path.join(root,'builds','release','stage');
  if (!fs.existsSync(path.join(runtime,'MediaYar.exe'))) throw new Error('Pass the existing MediaYar Windows runtime directory.');
  fs.mkdirSync(stage,{recursive:true});
  fs.cpSync(runtime,destination,{recursive:true});
  fs.cpSync(path.join(root,'src'),path.join(stage,'src'),{recursive:true});
  fs.cpSync(path.join(root,'assets'),path.join(stage,'assets'),{recursive:true});
  const pkg = require('../package.json');
  const {name,productName,version,description,main,author,license} = pkg;
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name,productName,version,description,main,author,license},null,2));
  await createPackage(stage,path.join(destination,'resources','app.asar'));
  console.log(`Packaged current desktop: ${destination}`);
})().catch(e => {console.error(e);process.exitCode=1;});
