import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADULT_RESPONSE_LABELS, CHILD_STATE_LABELS } from '../src/observation.ts';
import { buildPrompt } from '../src/prompt.ts';
import {
  EVALUATIVE_TERMS,
  FORBIDDEN_PATTERNS,
  FORBIDDEN_SAMPLES,
  LOOKS_LIKE_PRECEDING,
  normaliseForCheck,
  passesWordingCheck,
} from '../src/wording.ts';

/** scripts/check-expressions.mjs 의 FORBIDDEN 배열에 적힌 정규식을 '소스/플래그' 꼴로 읽는다. */
function checkerPatterns(): string[] {
  const source = readFileSync(new URL('../../scripts/check-expressions.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const FORBIDDEN = [');
  const end = source.indexOf('];', start);
  expect(start).toBeGreaterThan(-1);
  const block = source.slice(start, end);
  return [...block.matchAll(/\/((?:\\.|[^/\\\n])+)\/([a-z]*)/g)].map((m) => `${m[1]}/${m[2]}`);
}

describe('문장 검사 목록', () => {
  it('검수 스크립트의 금지 목록과 같다', () => {
    const fromChecker = checkerPatterns();
    expect(fromChecker.length).toBeGreaterThan(10);
    expect(FORBIDDEN_PATTERNS.map((p) => `${p.source}/${p.flags}`)).toEqual(fromChecker);
  });

  it('금지 목록의 모든 항목에 걸리는 예시가 있다', () => {
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(FORBIDDEN_SAMPLES.some((sample) => pattern.test(sample)), String(pattern)).toBe(true);
    }
    for (const sample of FORBIDDEN_SAMPLES) {
      expect(passesWordingCheck(`아이가 ${sample} 놀아요.`), sample).toBe(false);
    }
  });

  it('금지 표현 사이에 보이지 않는 글자를 끼워도 걸린다', () => {
    for (const sample of FORBIDDEN_SAMPLES) {
      const hidden = [...sample].join('\u200b');
      expect(passesWordingCheck(`아이가 ${hidden} 놀아요.`), sample).toBe(false);
    }
  });

  it('명세 6장의 평가·조언 낱말을 모두 담고 있다', () => {
    expect([...EVALUATIVE_TERMS]).toEqual([
      '문제', '장애', '이상', '정상', '비정상', '지연', '부족', '산만', '공격', '과잉', '결핍', '의심',
      '해야', '하세요', '바랍니다', '권장',
    ]);
    for (const term of EVALUATIVE_TERMS) expect(passesWordingCheck(`아이가 ${term}`), term).toBe(false);
  });

  it('명세의 태그 표시 문구는 문장 검사를 지나간다', () => {
    // 모델은 태그의 뜻으로 알려 준 말을 그대로 옮겨 쓰곤 한다. 그 말이 걸리면 요약이 통째로 사라진다.
    for (const label of Object.values(CHILD_STATE_LABELS)) expect(passesWordingCheck(`아이가 ${label}`), label).toBe(true);
    for (const label of Object.values(ADULT_RESPONSE_LABELS)) expect(passesWordingCheck(`어른이 ${label}`), label).toBe(true);
  });

  it('프롬프트에도 금지 표현이 없다', () => {
    const prompt = buildPrompt([0, 10], 20);
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(pattern.test(prompt.system), String(pattern)).toBe(false);
      expect(pattern.test(prompt.user), String(pattern)).toBe(false);
    }
  });
});

interface WordingCase {
  group: string;
  pass: boolean;
  text: string;
  note?: string;
}

/**
 * 걸려야 하는 문장과 지나가야 하는 문장은 모두 이 파일에 적는다(이 테스트 파일에 따로 적지 않는다).
 * hamkke-api 가 바이트 단위로 같은 사본을 ObservationSentenceFilter 에 돌린다.
 */
const casesRaw = readFileSync(new URL('./wording-cases.json', import.meta.url));
const { cases } = JSON.parse(casesRaw.toString('utf8')) as { cases: WordingCase[] };

describe('두 저장소가 함께 쓰는 예문 파일 (wording-cases.json)', () => {
  it('줄바꿈은 LF 이고 BOM 이 없다(두 저장소의 사본이 바이트 단위로 같아야 한다)', () => {
    expect(casesRaw.includes(0x0d)).toBe(false);
    expect(casesRaw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });

  it('예문마다 모양이 같고 겹치는 문장이 없다', () => {
    expect(cases.length).toBeGreaterThan(100);
    for (const c of cases) {
      expect(typeof c.group).toBe('string');
      expect(typeof c.pass).toBe('boolean');
      expect(typeof c.text).toBe('string');
      expect(c.text.length).toBeGreaterThan(0);
    }
    expect(new Set(cases.map((c) => c.text)).size).toBe(cases.length);
    expect(cases.filter((c) => c.pass).length).toBeGreaterThanOrEqual(20);
  });

  it.each(cases.filter((c) => !c.pass).map((c) => [c.group, c.text] as const))('걸린다 [%s] %s', (_group, text) => {
    expect(passesWordingCheck(text)).toBe(false);
  });

  it.each(cases.filter((c) => c.pass).map((c) => [c.text] as const))('지나간다: %s', (text) => {
    expect(passesWordingCheck(text)).toBe(true);
  });
});

describe('검사 전 글자 맞추기', () => {
  it('전각 글자를 반각으로, 풀어 쓴 자모를 완성형으로 바꾼다', () => {
    expect(normaliseForCheck('３살 ＡＢ')).toBe('3살 AB');
    expect(normaliseForCheck('\u110b\u1165\u11b7\u1106\u1161')).toBe('엄마');
  });

  it('보이지 않는 글자를 공백으로 바꾸지 않고 지운다', () => {
    const hiddenCodes = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x3164, 0xffa0, 0x115f, 0x1160, 0xfe0f, 0x034f];
    for (const code of hiddenCodes) {
      expect(normaliseForCheck(`가${String.fromCharCode(code)}나`), `U+${code.toString(16)}`).toBe('가나');
    }
  });

  it('여러 번 거쳐도 결과가 같다', () => {
    for (const c of cases) expect(normaliseForCheck(normaliseForCheck(c.text))).toBe(normaliseForCheck(c.text));
  });
});

describe("'-아/어 보여요' 앞 글자 목록", () => {
  it("받침이 없고 모음이 ㅏ·ㅓ·ㅕ·ㅝ 인 글자와 '해'에서 가·서·자·터·며·다·까 를 뺀 것이다", () => {
    const vowels = new Set([0, 4, 6, 14]); // ㅏ, ㅓ, ㅕ, ㅝ
    const skipped = new Set(['가', '서', '자', '터', '며', '다', '까']);
    const expected: string[] = [];
    for (let code = 0xac00; code <= 0xd7a3; code++) {
      const index = code - 0xac00;
      const ch = String.fromCharCode(code);
      if (index % 28 === 0 && vowels.has(Math.floor(index / 28) % 21) && !skipped.has(ch)) expected.push(ch);
    }
    expected.push('해');
    expect([...LOOKS_LIKE_PRECEDING].sort()).toEqual(expected.sort());
  });
});
