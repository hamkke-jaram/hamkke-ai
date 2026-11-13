#!/usr/bin/env node
// 표현 규칙 검수 (SPEC 2.1). 코드·화면 문구·시드 데이터에 금지 표현이 있으면 실패한다.
// 사용: node scripts/check-expressions.mjs   (CI에서 실행)
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = resolve(fileURLToPath(import.meta.url));
const root = join(self, '..', '..');
const TARGETS = ['src', 'server', 'eval/index.html', 'eval/eval.ts', 'eval/labels.example.json', 'scripts', 'docs', 'README.md'];
// 검수에서 빼는 파일은 이것 하나뿐이다: AI 서버의 문장 검사 목록.
// 모델이 쓴 문장에서 금지 표현을 걸러 내려면 그 목록을 코드로 갖고 있어야 한다(아래 FORBIDDEN 과 같은 목록).
// 이 낱말들은 그 파일 밖에 적지 않는다. 테스트도 그 파일이 내보낸 값을 가져다 쓴다.
const EXCLUDE = new Set([resolve(root, 'server/src/wording.ts')]);
const EXT = new Set(['.java', '.sql', '.yml', '.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.webmanifest', '.json', '.md']);

const FORBIDDEN = [
  /진단/, /판별/, /선별/, /위험도/, /치료/, /증상/, /예방/, /경계선\s*지능/, /정확도/,
  /위험\s*예측/, /WHO\s*프로그램/, /\b(Hanen|ESDM|PACT|JASPER)\b/,
  /diagnos/i, /screening/i, /risk/i, /treatment/i, /symptom/i, /therap/i, /accuracy/i,
  /predict/i, /prevent/i, /borderline/i,
];
// 고유명사(외부 기관·서비스 이름)와 바꿀 수 없는 브라우저 API 이름만 좁게 허용한다.
// num_predict 는 Ollama /api/chat 의 옵션 이름(만들 토큰 수 상한)이다. 요청 본문에 그 이름 그대로 써야 한다.
const ALLOW = [/자살예방상담전화/g, /K-DST\s*발달선별검사/g, /\.preventDefault\(\)/g, /\bnum_predict\b/g];

async function* walk(p) {
  let entries;
  try {
    entries = await readdir(p, { withFileTypes: true });
  } catch {
    yield p; // 파일
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(p, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let problems = 0;
for (const t of TARGETS) {
  for await (const file of walk(join(root, t))) {
    if (!EXT.has(extname(file)) || resolve(file) === self) continue; // 검수 스크립트 자신(금지 목록)은 제외
    if (EXCLUDE.has(resolve(file))) continue;
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((raw, i) => {
      let line = raw;
      for (const a of ALLOW) line = line.replace(a, '');
      for (const f of FORBIDDEN) {
        if (f.test(line)) {
          problems++;
          console.log(`${relative(root, file)}:${i + 1}  금지 표현 ${f}  →  ${raw.trim().slice(0, 120)}`);
        }
      }
    });
  }
}

if (problems) {
  console.error(`\n금지 표현 ${problems}건. docs/SPEC.md 2.1의 대체 표현을 써 주세요.`);
  process.exit(1);
}
console.log('표현 규칙 검수 통과');
