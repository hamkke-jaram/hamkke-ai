import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../src/prompt.ts';
import { EVALUATIVE_TERMS, FORBIDDEN_PATTERNS, FORBIDDEN_SAMPLES, passesWordingCheck } from '../src/wording.ts';

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

  it('명세 6장의 평가·조언 낱말을 모두 담고 있다', () => {
    expect([...EVALUATIVE_TERMS]).toEqual([
      '문제', '장애', '이상', '정상', '비정상', '지연', '부족', '산만', '공격', '과잉', '결핍', '의심',
      '해야', '하세요', '바랍니다', '권장',
    ]);
    for (const term of EVALUATIVE_TERMS) expect(passesWordingCheck(`아이가 ${term}`), term).toBe(false);
  });

  it('해요체로 쓴 조언·부탁을 거른다', () => {
    for (const sentence of [
      '아이가 울면 꼭 안아 주세요.',
      '아이에게 먼저 말을 걸어 보세요.',
      '어른이 아이를 달래 주면 좋겠어요.',
      '그럴 때는 그러지 마세요',
      '옆에서 기다려 주면 돼요.',
      '먼저 안아 주는 게 좋아요.',
      '어른의 도움이 필요해 보여요.',
      '천천히 기다려 주십시오.',
    ]) {
      expect(passesWordingCheck(sentence), sentence).toBe(false);
    }
  });

  it('까닭이나 속마음을 짐작하는 말을 거른다', () => {
    for (const sentence of [
      '아이가 졸려서 우는 것 같아요.',
      '블록이 무너졌기 때문이에요.',
      '아이가 졸린가 봐요.',
      '아이가 자나 봐요.',
      '아이가 졸린 듯해요.',
      '아마 배가 고파서 울어요.',
    ]) {
      expect(passesWordingCheck(sentence), sentence).toBe(false);
    }
  });

  it('나이 표기와 생김새를 평가하는 말을 거른다', () => {
    for (const sentence of [
      '5살쯤 된 아이가 앉아 있어요.',
      '세 살 아이가 앉아 있어요.',
      '열두 살 아이가 서 있어요.',
      '아이는 3세예요.',
      '18개월쯤 된 아이가 걸어요.',
      '통통한 아이가 웃어요.',
    ]) {
      expect(passesWordingCheck(sentence), sentence).toBe(false);
    }
  });

  it('비슷하게 생긴 흔한 관찰 문장은 거르지 않는다', () => {
    for (const sentence of [
      '아이가 공을 통통 튀겨요.',
      '아이가 블록 3세트를 쌓아요.',
      '아이가 자세 살펴보듯 블록을 들여다봐요.',
      '아이가 어른을 봐요.',
      '어른이 아이가 쌓은 블록을 봐요.',
      '아이가 블록을 좋아해요.',
      '아이가 기분이 좋아 보여요.',
      '아이가 어른과 같이 놀아요.',
      '아이가 블록 2개를 세워요.',
      '어른이 아이에게 다가가 봐요.',
    ]) {
      expect(passesWordingCheck(sentence), sentence).toBe(true);
    }
  });

  it('본 것만 적은 문장은 통과한다', () => {
    expect(passesWordingCheck('어른과 아이가 블록을 사이에 두고 마주 앉아 있어요.')).toBe(true);
    expect(passesWordingCheck('아이가 블록을 밀어내자 어른이 잠시 기다린 뒤 말을 걸어요.')).toBe(true);
    expect(passesWordingCheck('화면에 아이가 보이지 않아요.')).toBe(true);
  });

  it('프롬프트에도 금지 표현이 없다', () => {
    const prompt = buildPrompt([0, 10], 20);
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(pattern.test(prompt.system), String(pattern)).toBe(false);
      expect(pattern.test(prompt.user), String(pattern)).toBe(false);
    }
  });
});
