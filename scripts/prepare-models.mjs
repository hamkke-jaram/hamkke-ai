// MediaPipe WASM 런타임과 자세 추정 모델을 <대상>/mediapipe 아래에 준비한다.
// 사용: node prepare-models.mjs <public 폴더 경로>   (기본값: 현재 폴더의 public)
// 앱은 이 파일을 자기 서버에서만 제공하고, 영상은 어디로도 보내지 않는다.
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const publicDir = resolve(process.argv[2] ?? 'public');
const require = createRequire(join(process.cwd(), 'package.json'));
const wasmSrc = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
const wasmDst = join(publicDir, 'mediapipe', 'wasm');
const modelDst = join(publicDir, 'mediapipe', 'models', 'pose_landmarker_lite.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

await mkdir(wasmDst, { recursive: true });
for (const f of await readdir(wasmSrc)) await copyFile(join(wasmSrc, f), join(wasmDst, f));
console.log(`[prepare-models] wasm → ${wasmDst}`);

if (await exists(modelDst)) {
  console.log('[prepare-models] pose model already present');
} else {
  await mkdir(dirname(modelDst), { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(modelDst, buf);
  console.log(`[prepare-models] pose model downloaded (${(buf.length / 1e6).toFixed(1)} MB)`);
}
