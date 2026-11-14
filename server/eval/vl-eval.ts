// VL 관찰 기록 품질 평가 CLI. 사용법은 server/eval/README.md.
//   node server/eval/vl-eval.ts --labels server/eval/vl-labels.json [--csv out.csv] [--only clip-id] [--show-text]
// 서버와 같은 환경 변수(OLLAMA_URL, VL_MODEL, VL_FALLBACK_MODEL, OLLAMA_AUTH_TOKEN, VL_TIMEOUT_MS …)로 모델을 부른다.
// 사진은 메모리에서만 다루고, 결과에는 태그 이름과 숫자만 남긴다.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../src/config.ts';
import { PROMPT_VERSION } from '../src/prompt.ts';
import { createProviderFromConfig } from '../src/providers.ts';
import { LabelError, parseLabels, runClip, summarise, toCsv } from './harness.ts';
import type { ClipResult, GroupTotals } from './harness.ts';

const USAGE = `사용법: node server/eval/vl-eval.ts --labels <라벨 JSON> [--csv <결과 CSV>] [--only <클립 id>] [--show-text]`;

function ratio(value: number | null): string {
  return value === null ? '–' : value.toFixed(2);
}

function groupLine(name: string, totals: GroupTotals): string {
  return `${name}: 일치 ${totals.matched}, 놓침 ${totals.missed}, 더함 ${totals.extra} (precision ${ratio(totals.precision)}, recall ${ratio(totals.recall)})`;
}

function clipLine(r: ClipResult): string {
  const tags = (c: ClipResult['childStates']) => `${c.matched.length}/${c.missed.length}/${c.extra.length}`;
  const people = r.peopleExpected === null ? '–' : `${r.peopleGot ?? '–'}/${r.peopleExpected}`;
  return [
    r.id.padEnd(24),
    r.outcome.padEnd(20),
    String(r.attempts).padStart(2),
    `${(r.ms / 1000).toFixed(1)}s`.padStart(8),
    tags(r.childStates).padStart(8),
    tags(r.adultResponses).padStart(8),
    people.padStart(6),
    `${r.text.wordingRejected}/${r.text.dropped}/${r.text.written}`.padStart(9),
    r.model ?? '–',
  ].join('  ');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      labels: { type: 'string', default: 'server/eval/vl-labels.json' },
      csv: { type: 'string' },
      only: { type: 'string' },
      'show-text': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const config = loadConfig(process.env);
  for (const warning of config.warnings) console.warn(`경고: ${warning}`);
  const labelsPath = resolve(values.labels);
  const baseDir = dirname(labelsPath);
  let clips = parseLabels(JSON.parse(await readFile(labelsPath, 'utf8')) as unknown);
  if (values.only) clips = clips.filter((clip) => clip.id === values.only);
  if (clips.length === 0) {
    console.error('평가할 클립이 없어요. 라벨 파일과 --only 값을 확인해 주세요.');
    return 1;
  }

  const provider = createProviderFromConfig(config);
  if (!(await provider.isReady(AbortSignal.timeout(5_000)))) {
    console.error(`모델을 쓸 수 없어요: ${config.ollamaUrl} 에서 ${config.model} 을(를) 확인해 주세요(ollama pull).`);
    return 1;
  }
  console.log(`모델 ${config.model}${config.fallbackModel ? ` (대신 쓰는 모델 ${config.fallbackModel})` : ''}, 프롬프트 ${PROMPT_VERSION}, 클립 ${clips.length}개`);
  console.log('태그 칸은 일치/놓침/더함, 사람 칸은 모델/라벨, 글 칸은 문장 검사에 걸림/버려짐/모델이 쓴 글 수예요.\n');
  console.log(['클립'.padEnd(24), '결과'.padEnd(20), '시도', '걸린 시간', '아이 태그', '어른 태그', '사람 수', '글', '모델'].join('  '));

  const results: ClipResult[] = [];
  for (const clip of clips) {
    let frames: { t: number; jpeg: Buffer }[];
    try {
      frames = await Promise.all(clip.frames.map(async (f) => ({ t: f.t, jpeg: await readFile(resolve(baseDir, f.file)) })));
    } catch {
      console.error(`${clip.id}: 사진 파일을 읽지 못했어요. 라벨 파일 기준 경로를 확인해 주세요.`);
      results.push({
        id: clip.id,
        outcome: 'missing_files',
        attempts: 0,
        ms: 0,
        model: null,
        childStates: { matched: [], missed: [...clip.expected.childStates], extra: [] },
        adultResponses: { matched: [], missed: [...clip.expected.adultResponses], extra: [] },
        peopleExpected: clip.expected.peopleCount ?? null,
        peopleGot: null,
        text: { written: 0, wordingRejected: 0, dropped: 0, invalidTags: 0 },
        summary: null,
      });
      continue;
    }
    const result = await runClip(provider, clip, frames, config.timeoutMs);
    for (const frame of frames) frame.jpeg.fill(0);
    results.push(result);
    console.log(clipLine(result));
    if (values['show-text'] && result.summary !== null) console.log(`    요약: ${result.summary}`);
  }

  const totals = summarise(results);
  console.log(`\n클립 ${totals.clips}개 가운데 기록을 얻은 클립 ${totals.ok}개, 다시 부른 클립 ${totals.retried}개, 모두 ${(totals.msTotal / 1000).toFixed(1)}초`);
  console.log(groupLine('아이 모습', totals.childStates));
  console.log(groupLine('어른 반응', totals.adultResponses));
  console.log(groupLine('태그 전체', totals.allTags));
  if (totals.peopleLabelled > 0) console.log(`사람 수: 라벨이 있는 ${totals.peopleLabelled}개 가운데 ${totals.peopleMatched}개 같음`);
  console.log(
    `글: 모델이 쓴 ${totals.text.written}개 가운데 문장 검사에 걸림 ${totals.text.wordingRejected}개, 최종 기록에서 빠짐 ${totals.text.dropped}개, 목록에 없는 태그 ${totals.text.invalidTags}개`,
  );
  console.log('\n이 숫자는 내부 개선용이에요. 앱이나 발표 자료에 퍼센트로 옮기지 않아요.');

  if (values.csv) {
    await writeFile(resolve(values.csv), toCsv(results), 'utf8');
    console.log(`CSV: ${resolve(values.csv)} (태그 이름과 숫자만, 문장 없음)`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ConfigError || err instanceof LabelError) console.error(err.message);
    else if (err instanceof SyntaxError) console.error('라벨 파일이 JSON 형식이 아니에요.');
    else if ((err as NodeJS.ErrnoException).code === 'ENOENT') console.error(`라벨 파일을 찾지 못했어요.\n${USAGE}`);
    else if (err instanceof TypeError && /parseArgs|option/i.test(err.message)) console.error(USAGE);
    else console.error(`평가를 끝내지 못했어요: ${err instanceof Error ? err.name : 'unknown'}`);
    process.exit(1);
  },
);
