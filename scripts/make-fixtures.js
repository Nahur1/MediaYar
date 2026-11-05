'use strict';
// Reproducible synthetic media; no personal or copyrighted files required.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const dir = path.join(__dirname, '..', 'test', 'fixtures');
fs.mkdirSync(dir, { recursive: true });
const run = (name, args) => {
  if (fs.existsSync(path.join(dir, name))) return;
  console.log(`Generating ${name}`);
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', ...args, path.join(dir, name)], { stdio: 'inherit' });
};
run('sample.mp4', ['-f','lavfi','-i','testsrc2=s=1280x720:r=30:d=8','-f','lavfi','-i','sine=f=440:r=48000:d=8','-c:v','libx264','-preset','ultrafast','-crf','20','-g','30','-c:a','aac','-ac','2','-shortest']);
run('big.mp4', ['-f','lavfi','-i','testsrc2=s=1920x1080:r=30:d=20','-f','lavfi','-i','sine=f=660:r=48000:d=20','-c:v','libx264','-preset','ultrafast','-b:v','8M','-g','30','-c:a','aac','-ac','2','-shortest']);
run('stereo.wav', ['-f','lavfi','-i','sine=f=440:r=48000:d=6','-ac','2','-c:a','pcm_s16le']);
run('surround51.flac', ['-f','lavfi','-i','aevalsrc=sin(440*2*PI*t)|sin(550*2*PI*t)|sin(660*2*PI*t)|sin(100*2*PI*t)|sin(330*2*PI*t)|sin(220*2*PI*t):s=48000:d=6:c=5.1','-c:a','flac']);
run('odd_noaudio.avi', ['-f','lavfi','-i','testsrc=s=641x479:r=24:d=8','-c:v','ffv1','-pix_fmt','bgr0']);
run('portrait_rot.mp4', ['-display_rotation','90','-i',path.join(dir,'sample.mp4'),'-c','copy']);
fs.writeFileSync(path.join(dir,'subtitles.srt'), '1\n00:00:00,000 --> 00:00:04,000\nMedia Yar test\n');
run('multi.mkv', ['-i',path.join(dir,'sample.mp4'),'-f','lavfi','-i','sine=f=880:r=48000:d=8','-i',path.join(dir,'subtitles.srt'),'-map','0:v','-map','0:a','-map','1:a','-map','2:s','-c:v','copy','-c:a','aac','-c:s','srt']);
fs.copyFileSync(path.join(dir,'sample.mp4'), path.join(dir,'ویدیو تست با فاصله.mp4'));
