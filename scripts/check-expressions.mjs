#!/usr/bin/env node
// 표현 규칙 검수 (SPEC 2.1). 코드·화면 문구·시드 데이터에 금지 표현이 있으면 실패한다.
// 사용: node scripts/check-expressions.mjs   (CI에서 실행)
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const TARGETS = ['src', 'eval/index.html', 'eval/eval.ts'];
const EXT = new Set(['.java', '.sql', '.yml', '.ts', '.tsx', '.css', '.html', '.webmanifest', '.json']);

const FORBIDDEN = [
  /진단/, /판별/, /선별/, /위험도/, /치료/, /증상/, /예방/, /경계선\s*지능/, /정확도/,
  /diagnos/i, /screening/i, /\brisk/i, /treatment/i, /symptom/i, /therap/i, /accuracy/i,
];
// 고유명사(외부 기관·서비스 이름)는 허용한다.
const ALLOW = [/자살예방상담전화/g, /K-DST\s*발달선별검사/g];

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
    if (!EXT.has(extname(file))) continue;
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
