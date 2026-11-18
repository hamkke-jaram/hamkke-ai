// AI 관찰 기록 엣지 케이스·품질 시험 CLI. 사진은 이 기기 밖으로 보내지 않는다(로컬 모델 서버만).
// 결과에는 갈래 이름·상태 코드·숫자만 남는다. 모델이 쓴 문장과 사진은 메모리에서만 다룬다.
//
//   장면별 N회: node server/eval/edge.ts scenes [--dir server/eval/frames/edge] [--runs 5] [--only a,b] [--csv out.csv]
//     서버와 같은 순서(사진 검사 → 프롬프트 → 모델 최대 2번 → 다듬기·문장 검사)로 모델을 직접 부른다.
//     환경 변수는 서버와 같다(OLLAMA_URL, VL_MODEL, VL_TIMEOUT_MS, VL_MAX_OUTPUT_TOKENS, VL_NUM_CTX, VL_KEEP_ALIVE …).
//   입력 검사: node server/eval/edge.ts inputs --server http://127.0.0.1:18090 [--inputs server/eval/frames/edge-inputs] [--model-cases]
//   동시 요청: node server/eval/edge.ts load --server http://127.0.0.1:18090 [--concurrency 5] [--scene coaching]
//   inputs·load 는 실제 서버에 개발용 비밀(또는 AI_SHARED_SECRET)로 만든 분석 토큰을 보낸다.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEV_SHARED_SECRET, loadConfig } from '../src/config.ts';
import { FrameError, parseAnalyzeBody } from '../src/frames.ts';
import { signJwt } from '../src/jwt.ts';
import { ADULT_RESPONSES, CHILD_STATES } from '../src/observation.ts';
import { buildPrompt } from '../src/prompt.ts';
import { ProviderTimeoutError, ProviderUnavailableError, toVisionOutput } from '../src/provider.ts';
import { createProviderFromConfig } from '../src/providers.ts';
import { analyseOutput, SCENE_CSV_HEADER, sceneCsvRow, sceneLine, summariseScene } from './edge-lib.ts';
import type { AttemptRecord, RunRecord } from './edge-lib.ts';

const TAGS = [...CHILD_STATES, ...ADULT_RESPONSES];
const ATTEMPTS = 2; // app.ts MODEL_ATTEMPTS
/** --retry-hint 실험: 두 번째 호출에만 덧붙이는 안내(서버 프롬프트에는 없다. 효과를 재 보고 obs-v3 로 넣을지 정한다). */
const RETRY_HINT =
  '앞선 답은 쓸 수 없었어요. 사진 속 글자·숫자·이름은 옮겨 적지 말고, 보이는 사람의 모습과 움직임만 적어 주세요. ' +
  '사람이 보이지 않으면 summary 는 "화면에 아이가 보이지 않아요." 한 문장만 써요.';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: 'server/eval/frames/edge' },
    inputs: { type: 'string', default: 'server/eval/frames/edge-inputs' },
    runs: { type: 'string', default: '5' },
    only: { type: 'string' },
    csv: { type: 'string' },
    server: { type: 'string', default: 'http://127.0.0.1:18090' },
    concurrency: { type: 'string', default: '5' },
    scene: { type: 'string', default: 'coaching' }, // 6장짜리 장면
    'model-cases': { type: 'boolean', default: false },
    reuse: { type: 'boolean', default: false },
    frames: { type: 'string', default: '6' },
    'retry-hint': { type: 'boolean', default: false },
    'long-edge': { type: 'string' },
  },
});

/**
 * 요청마다 사진 한 귀퉁이의 2×2 픽셀을 바꿔 새 사진으로 만든다(ffmpeg). 같은 사진을 다시 보내면 Ollama 가
 * 앞서 읽은 결과를 재사용해 실제보다 빠르게 재진다. 실제 요청의 사진은 늘 새 사진이다. --reuse 면 그대로 쓴다.
 */
/** 실행마다 다른 값. 같은 순번이라도 앞선 실행과 같은 사진이 나오지 않게 한다(Ollama 가 그림 결과를 기억한다). */
const RUN_SALT = randomBytes(4).readUInt32LE(0);

function freshCopy(jpeg: Buffer, seed: number, longEdge?: number): Buffer {
  const mixed = (seed + RUN_SALT) >>> 0;
  const color = (0x100000 + ((mixed * 2654435761) % 0xefffff)).toString(16);
  const scale = longEdge ? `scale='if(gt(iw,ih),${longEdge},-2)':'if(gt(iw,ih),-2,${longEdge})',` : '';
  return execFileSync(
    'ffmpeg',
    ['-v', 'error', '-f', 'jpeg_pipe', '-i', '-', '-vf', `${scale}drawbox=x=${mixed % 8}:y=${(mixed >> 3) % 4}:w=2:h=2:color=0x${color}:t=fill`, '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
    { input: jpeg, maxBuffer: 8 * 1024 * 1024 },
  );
}

function sceneFrames(dir: string): { t: number; jpeg: Buffer }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .slice(0, 6)
    .map((f, i) => ({ t: i * 5, jpeg: readFileSync(join(dir, f)) }));
}

// ---------------------------------------------------------------- scenes
async function scenes(): Promise<number> {
  const config = loadConfig(process.env);
  // Ollama 응답에서 끝난 까닭·토큰 수만 읽는다(본문 글은 provider 가 돌려주는 것만 메모리에서 쓴다).
  type Meta = { doneReason: string | null; promptTokens: number | null; outputTokens: number | null };
  const last: { meta: Meta | null } = { meta: null };
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (String(input).endsWith('/api/chat') && res.ok) {
      try {
        const data = (await res.clone().json()) as Record<string, unknown>;
        last.meta = {
          doneReason: typeof data.done_reason === 'string' ? data.done_reason : null,
          promptTokens: typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : null,
          outputTokens: typeof data.eval_count === 'number' ? data.eval_count : null,
        };
      } catch {
        last.meta = null;
      }
    }
    return res;
  };
  const provider = createProviderFromConfig(config, { fetchImpl: recordingFetch });
  if (!(await provider.isReady(AbortSignal.timeout(5_000)))) {
    console.error(`모델을 쓸 수 없어요: ${config.ollamaUrl} ${config.model}`);
    return 1;
  }
  const root = resolve(values.dir);
  let names = readdirSync(root).filter((n) => !n.includes('.')).sort();
  if (values.only) names = names.filter((n) => values.only!.split(',').includes(n));
  const runs = Number(values.runs);
  console.log(`모델 ${config.model} @ ${config.ollamaUrl} · 출력 상한 ${config.maxOutputTokens} · 제한 ${config.timeoutMs}ms · ${runs}회 · 사진 ${values.frames}장${values['long-edge'] ? ` · 긴 변 ${values['long-edge']}px` : ''}`);

  const summaries = [];
  for (const name of names) {
    const frames = sceneFrames(join(root, name)).slice(0, Number(values.frames));
    const longEdge = values['long-edge'] ? Number(values['long-edge']) : undefined;
    const records: RunRecord[] = [];
    for (let r = 0; r < runs; r++) {
      const sent = values.reuse ? frames : frames.map((f, i) => ({ t: f.t, jpeg: freshCopy(f.jpeg, r * 10 + i + 1, longEdge) }));
      const body = Buffer.from(JSON.stringify({ frames: sent.map((f) => ({ t: f.t, jpeg: f.jpeg.toString('base64') })), durationSec: 30 }));
      let input;
      try {
        input = parseAnalyzeBody(body);
      } catch (err) {
        records.push({ scene: name, outcome: `invalid_frames:${err instanceof FrameError ? err.reason : 'unknown'}`, ms: 0, attempts: [] });
        continue;
      }
      const frameTimes = input.frames.map((f) => f.t);
      const prompt = buildPrompt(frameTimes, input.durationSec);
      const images = input.frames.map((f) => f.jpeg);
      const deadline = AbortSignal.timeout(config.timeoutMs);
      const started = performance.now();
      const attempts: AttemptRecord[] = [];
      let outcome = 'bad_output';
      for (let a = 1; a <= ATTEMPTS; a++) {
        const t0 = performance.now();
        last.meta = null;
        let text: string;
        try {
          const user = a > 1 && values['retry-hint'] ? `${prompt.user}\n${RETRY_HINT}` : prompt.user;
          ({ text } = toVisionOutput(await provider.generate({ ...prompt, user, images, signal: deadline }), provider.modelVersion));
        } catch (err) {
          const timedOut = deadline.aborted || err instanceof ProviderTimeoutError;
          attempts.push({
            ms: performance.now() - t0, result: timedOut ? 'timeout' : `unavailable:${err instanceof ProviderUnavailableError ? err.detail : 'error'}`,
            doneReason: null, promptTokens: null, outputTokens: null, verdicts: [], groupHits: {}, summaryKept: false, peopleCount: null,
          });
          if (timedOut) {
            outcome = 'timeout';
            break;
          }
          outcome = 'unavailable';
          continue;
        }
        const analysis = analyseOutput(text, frameTimes, TAGS);
        const m = last.meta as Meta | null; // fetch 안에서 채워진다
        attempts.push({
          ms: performance.now() - t0, result: analysis.result,
          doneReason: m?.doneReason ?? null, promptTokens: m?.promptTokens ?? null, outputTokens: m?.outputTokens ?? null,
          verdicts: analysis.verdicts, groupHits: analysis.groupHits,
          summaryKept: analysis.observation?.summary != null, peopleCount: analysis.peopleCount,
        });
        text = '';
        if (analysis.observation !== null) {
          outcome = 'ok';
          break;
        }
        outcome = 'bad_output';
      }
      records.push({ scene: name, outcome, ms: performance.now() - started, attempts });
      process.stdout.write('.');
    }
    const summary = summariseScene(name, records);
    summaries.push(summary);
    process.stdout.write('\n');
    console.log(sceneLine(summary));
  }
  if (values.csv) {
    writeFileSync(values.csv, `${[SCENE_CSV_HEADER.join(','), ...summaries.map(sceneCsvRow)].join('\n')}\n`);
    console.log(`CSV → ${values.csv}`);
  }
  return 0;
}

// ---------------------------------------------------------------- http helpers
const secret = Buffer.from(process.env.AI_SHARED_SECRET ?? DEV_SHARED_SECRET, 'utf8');

function token(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { iss: 'hamkke-api', aud: 'hamkke-ai', iat: now, exp: now + 600, sub: 'edge-check', cid: 1, src: 'HOME', jti: randomBytes(12).toString('base64url'), ...overrides },
    secret,
  );
}

interface HttpResult {
  status: number;
  code: string;
  ms: number;
}

async function post(body: string | Buffer, opts: { auth?: string | null; type?: string } = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { 'Content-Type': opts.type ?? 'application/json' };
  const auth = opts.auth === undefined ? token() : opts.auth;
  if (auth !== null) headers.Authorization = `Bearer ${auth}`;
  const t0 = performance.now();
  try {
    const res = await fetch(`${values.server}/ai/v1/analyze`, { method: 'POST', headers, body });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { status: res.status, code: String(data.code ?? data.error?.code ?? (res.ok ? 'OK' : '?')), ms: performance.now() - t0 };
  } catch (err) {
    return { status: 0, code: `fetch:${(err as Error).message.slice(0, 40)}`, ms: performance.now() - t0 };
  }
}

const frameBody = (jpegs: Buffer[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ frames: jpegs.map((j, i) => ({ t: i * 5, jpeg: j.toString('base64') })), durationSec: 30, ...extra });

/** JPEG 시작(FF D8) 바로 뒤에 GPS 위치가 든 EXIF(APP1)를 끼워 넣는다. */
export function withGpsExif(jpeg: Buffer): Buffer {
  // TIFF(리틀 엔디언): IFD0 에 GPSInfo(0x8825) 하나 → GPS IFD 에 위도 참조·위도 두 항목.
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 * 2 + 4 + 24);
  let o = 0;
  tiff.write('II', o); o += 2;
  tiff.writeUInt16LE(42, o); o += 2;
  tiff.writeUInt32LE(8, o); o += 4;
  tiff.writeUInt16LE(1, o); o += 2; // IFD0 항목 수
  tiff.writeUInt16LE(0x8825, o); tiff.writeUInt16LE(4, o + 2); tiff.writeUInt32LE(1, o + 4); tiff.writeUInt32LE(26, o + 8); o += 12;
  tiff.writeUInt32LE(0, o); o += 4;
  tiff.writeUInt16LE(2, o); o += 2; // GPS IFD 항목 수 (offset 26)
  tiff.writeUInt16LE(1, o); tiff.writeUInt16LE(2, o + 2); tiff.writeUInt32LE(2, o + 4); tiff.write('N\0', o + 8); o += 12;
  tiff.writeUInt16LE(2, o); tiff.writeUInt16LE(5, o + 2); tiff.writeUInt32LE(3, o + 4); tiff.writeUInt32LE(56, o + 8); o += 12;
  tiff.writeUInt32LE(0, o); o += 4;
  for (const [num, den] of [[37, 1], [33, 1], [3000, 100]]) { tiff.writeUInt32LE(num!, o); tiff.writeUInt32LE(den!, o + 4); o += 8; }
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

// ---------------------------------------------------------------- inputs
async function inputs(): Promise<number> {
  const dir = resolve(values.inputs);
  const file = (name: string) => readFileSync(join(dir, name));
  const base = sceneFrames(join(resolve(values.dir), values.scene)).map((f) => f.jpeg);
  const one = base[0]!;
  const padded = Buffer.concat([one, Buffer.alloc(310 * 1024 - one.length)]); // 끝 뒤에 0 을 덧붙여 300KB 를 넘김
  const cases: Array<[string, string, () => Promise<HttpResult>]> = [
    ['사진 0장', '400', () => post(frameBody([]))],
    ['사진 7장', '400', () => post(frameBody([...base, one, one].slice(0, 7)))],
    ['빈 문자열(0바이트)', '400', () => post(JSON.stringify({ frames: [{ t: 0, jpeg: '' }] }))],
    ['깨진 JPEG(앞 100바이트)', '400', () => post(frameBody([one.subarray(0, 100)]))],
    ['PNG 를 JPEG 로 속임', '400', () => post(frameBody([file('real.png')]))],
    ['GIF 를 JPEG 로 속임', '400', () => post(frameBody([file('real.gif')]))],
    ['글자 파일을 JPEG 로 속임', '400', () => post(frameBody([Buffer.from('hello, this is not an image at all')]))],
    ['base64 아님', '400', () => post(JSON.stringify({ frames: [{ t: 0, jpeg: '***not base64***' }] }))],
    ['15×15(최소 미만)', '400', () => post(frameBody([file('15x15.jpg')]))],
    ['2050×32(최대 넘음)', '400', () => post(frameBody([file('2050x32.jpg')]))],
    ['한 장 310KB(300KB 넘음)', '400', () => post(frameBody([padded]))],
    ['한 장 1.6MB(본문 2MB 넘음)', '413', () => post(frameBody([file('over-300kb.jpg')]))],
    ['시각이 음수', '400', () => post(JSON.stringify({ frames: [{ t: -1, jpeg: one.toString('base64') }] }))],
    ['영상 길이 0', '400', () => post(frameBody([one], { durationSec: 0 }))],
    ['JSON 아님', '400', () => post('{"frames": [', {})],
    ['Content-Type text/plain', '415', () => post(frameBody([one]), { type: 'text/plain' })],
    ['토큰 없음', '401', () => post(frameBody([one]), { auth: null })],
    ['만료된 토큰', '401', () => post(frameBody([one]), { auth: token({ iat: Math.floor(Date.now() / 1000) - 700, exp: Math.floor(Date.now() / 1000) - 10 }) })],
    ['수명 11분 넘는 토큰', '401', () => post(frameBody([one]), { auth: token({ exp: Math.floor(Date.now() / 1000) + 3600 }) })],
    ['다른 비밀로 서명', '401', () => post(frameBody([one]), { auth: signJwt({ iss: 'hamkke-api', aud: 'hamkke-ai', iat: 1, exp: 2 }, Buffer.from('x'.repeat(40))) })],
  ];
  if (values['model-cases']) {
    const replay = token();
    cases.push(
      ['사진 1장', '200', () => post(frameBody([one]))],
      ['사진 6장', '200', () => post(frameBody(base))],
      ['16×16(최소)', '200', () => post(frameBody([file('16x16.jpg')]))],
      ['2048×16(최대)', '200', () => post(frameBody([file('2048x16.jpg')]))],
      ['세로 288×512', '200', () => post(frameBody([file('portrait-288x512.jpg')]))],
      ['EXIF GPS 위치가 든 사진', '200', () => post(frameBody([withGpsExif(one)]))],
      ['같은 토큰 첫 사용', '200', () => post(frameBody([one]), { auth: replay })],
      ['같은 토큰 다시 사용', '409', () => post(frameBody([one]), { auth: replay })],
    );
  }
  let wrong = 0;
  for (const [name, expected, run] of cases) {
    const r = await run();
    const ok = String(r.status) === expected;
    if (!ok) wrong++;
    console.log(`${ok ? 'OK ' : 'XX '} ${name.padEnd(26)} 기대 ${expected} → ${r.status} ${r.code.padEnd(24)} ${(r.ms / 1000).toFixed(1)}s`);
  }
  console.log(`${cases.length}건 중 기대와 다름 ${wrong}건`);
  return wrong === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- load
async function load(): Promise<number> {
  const n = Number(values.concurrency);
  const frames = sceneFrames(join(resolve(values.dir), values.scene)).map((f) => f.jpeg);
  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      await new Promise((r) => setTimeout(r, i * 50)); // 들어오는 순서를 고정
      const r = await post(frameBody(frames));
      return { i, ...r, doneAt: performance.now() - t0 };
    }),
  );
  for (const r of results) console.log(`요청 ${r.i + 1}: ${r.status} ${r.code.padEnd(20)} ${(r.ms / 1000).toFixed(1)}s`);
  const by = results.reduce<Record<string, number>>((m, r) => ((m[`${r.status} ${r.code}`] = (m[`${r.status} ${r.code}`] ?? 0) + 1), m), {});
  console.log(`동시 ${n}건: ${Object.entries(by).map(([k, v]) => `${k} ×${v}`).join(', ')} · 전체 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return 0;
}

const command = positionals[0];
const run = command === 'scenes' ? scenes : command === 'inputs' ? inputs : command === 'load' ? load : null;
if (run === null) {
  console.error('사용법: node server/eval/edge.ts scenes|inputs|load [옵션] (파일 첫머리 설명 참고)');
  process.exitCode = 1;
} else {
  process.exitCode = await run();
}
