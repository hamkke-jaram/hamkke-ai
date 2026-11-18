// 기기 내 분석(analyzeVideo) 엣지 케이스용 합성 영상을 만든다(사람 없음, ffmpeg 필요).
//   node scripts/edge-videos.mjs [출력 폴더=eval/public/edge-videos]
// 만든 목록은 manifest.json 에 적는다. 평가 페이지 eval/edge-videos.html 이 읽는다. 출력 폴더는 .gitignore 안쪽이다.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'eval/public/edge-videos');
mkdirSync(out, { recursive: true });

function ff(...a) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: ['ignore', 'ignore', 'inherit'] });
}

const V = (size, rate = 30) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`];
const tone = (f, extra = '') => ['-f', 'lavfi', '-i', `sine=frequency=${f}:sample_rate=48000${extra}`];
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p'];
const AAC = ['-c:a', 'aac', '-b:a', '64k'];

// [파일, 설명, 기대(ok | error), 만들기]
const items = [
  ['silent-audio.mp4', '소리 트랙은 있으나 완전 무음', 'ok', (f) => ff(...V('640x360'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '20', ...H264, ...AAC, f)],
  ['audio-only.m4a', '소리만 있고 영상 없음', 'error', (f) => ff(...tone(330), '-t', '20', ...AAC, f)],
  ['video-only.mp4', '영상만 있고 소리 트랙 없음', 'error', (f) => ff(...V('640x360'), '-t', '20', ...H264, f)],
  ['short-3s.mp4', '3초(10초 미만)', 'error', (f) => ff(...V('640x360'), ...tone(330), '-t', '3', ...H264, ...AAC, f)],
  ['exact-10s.mp4', '정확히 10초(하한)', 'ok', (f) => ff(...V('640x360'), ...tone(330), '-t', '10', ...H264, ...AAC, f)],
  ['long-30min.mp4', '30분(상한), 작은 화면', 'ok', (f) => ff(...V('320x180', 15), ...tone(330), '-t', '1800', ...H264, '-crf', '40', ...AAC, f)],
  ['over-30min.mp4', '30분 10초(상한 넘음)', 'error', (f) => ff(...V('160x90', 5), ...tone(330), '-t', '1810', ...H264, '-crf', '45', ...AAC, f)],
  ['portrait-rotate.mp4', '가로 영상에 90도 회전 표시(세로 촬영)', 'ok', (f) => {
    const tmp = `${f}.tmp.mp4`;
    ff(...V('640x360'), ...tone(330), '-t', '20', ...H264, ...AAC, tmp);
    ff('-display_rotation', '90', '-i', tmp, '-c', 'copy', f);
  }],
  ['vfr.mp4', '가변 프레임(프레임 간격이 들쭉날쭉)', 'ok', (f) => ff(...V('640x360', 30), ...tone(330), '-t', '20', '-vf', "select='not(mod(n\\,3))+lt(random(0)\\,0.3)'", '-fps_mode', 'vfr', ...H264, ...AAC, f)],
  ['fps60.mp4', '60fps', 'ok', (f) => ff(...V('1280x720', 60), ...tone(330), '-t', '20', ...H264, ...AAC, f)],
  ['uhd-4k.mp4', '4K(3840x2160)', 'ok', (f) => ff(...V('3840x2160', 30), ...tone(330), '-t', '15', ...H264, ...AAC, f)],
  ['hevc.mp4', 'HEVC(H.265) 영상', 'ok', (f) => ff(...V('1280x720'), ...tone(330), '-t', '15', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', ...AAC, f)],
  ['broken.mp4', '중간이 잘린 파일', 'error', (f) => {
    const tmp = `${f}.full.mp4`;
    ff(...V('640x360'), ...tone(330), '-t', '20', ...H264, '-movflags', '+faststart', ...AAC, tmp);
    const bytes = readFileSync(tmp);
    writeFileSync(f, bytes.subarray(0, Math.floor(bytes.length * 0.4)));
  }],
  ['not-video.mp4', '확장자만 mp4 인 글자 파일', 'error', (f) => writeFileSync(f, 'not a video at all\n'.repeat(100))],
  ['loud-noise.mp4', '큰 잡음만', 'ok', (f) => ff(...V('640x360'), '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.9:sample_rate=48000', '-t', '20', ...H264, ...AAC, f)],
  ['music-only.mp4', '음악(화음)만', 'ok', (f) => ff(...V('640x360'), '-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*262*t)+0.2*sin(2*PI*330*t)+0.2*sin(2*PI*392*t)':s=48000", '-t', '20', ...H264, ...AAC, f)],
  ['high-pitch-320hz.mp4', '어른 고음 흉내(320Hz 말소리 같은 소리 반복)', 'ok', (f) => ff(...V('640x360'), '-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*320*t)*lt(mod(t\\,4)\\,1.2)':s=48000", '-t', '20', ...H264, ...AAC, f)],
];

const manifest = [];
for (const [file, label, expect, make] of items) {
  const path = join(out, file);
  try {
    make(path);
    manifest.push({ file, label, expect, bytes: statSync(path).size });
    console.log(`만듦 ${file} (${(statSync(path).size / 1e6).toFixed(1)}MB)`);
  } catch (err) {
    console.warn(`건너뜀 ${file}: ${err.message.split('\n')[0]}`);
  }
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${manifest.length}개 → ${out}`);
