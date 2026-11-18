import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  analyseOutput,
  percentile,
  sceneCsvRow,
  summariseScene,
  textVerdict,
  wordingGroups,
  WORDING_GROUPS,
} from '../eval/edge-lib.ts';
import type { RunRecord } from '../eval/edge-lib.ts';
import { ADULT_RESPONSES, CHILD_STATES, normaliseObservation } from '../src/observation.ts';
import { FORBIDDEN_SAMPLES, passesWordingCheck } from '../src/wording.ts';

const { cases } = JSON.parse(readFileSync(new URL('./wording-cases.json', import.meta.url), 'utf8')) as {
  cases: { text: string; pass: boolean }[];
};
const TAGS = [...CHILD_STATES, ...ADULT_RESPONSES];

// 예문 파일 + 금지 표현 예시 + 해요체가 아니거나 한국어가 아닌 글.
const SAMPLES = [
  ...cases.map((c) => c.text),
  ...FORBIDDEN_SAMPLES.map((s) => `아이가 ${s} 놀아요.`),
  '아이가 블록을 쌓는다.',
  '아이가 블록을 쌓습니다.',
  'The child is stacking blocks.',
  '子供が遊んでいます。아이가 놀아요.',
  '   ',
  '아이가 졸린가 봐요.',
  '아이가 화가 난 듯 블록을 던져요.',
  '아이가 살펴보듯 블록을 봐요.',
];

describe('문장 검사 갈래 가르기 (wordingGroups)', () => {
  it('갈래 목록은 검사 순서대로 10개다', () => {
    expect(WORDING_GROUPS.map(([name]) => name)).toEqual([
      'FORBIDDEN', 'EVALUATIVE', 'ADVICE', 'GUESS', 'PERSONAL', 'LABELING', 'JUDGING', 'INNER_STATE', 'PERSON', 'READING',
    ]);
  });

  it.each(SAMPLES.map((t) => [t]))('걸리는 갈래가 없으면 문장 검사를 지나간다: %s', (text) => {
    expect(wordingGroups(text).length === 0).toBe(passesWordingCheck(text));
  });

  it('예문의 갈래를 바르게 짚는다', () => {
    expect(wordingGroups('아이가 졸린가 봐요.')).toContain('GUESS');
    expect(wordingGroups('아이가 화가 난 듯 블록을 던져요.')).toContain('INNER_STATE');
    expect(wordingGroups('엄마가 블록을 쌓아요.')).toContain('PERSON');
    expect(wordingGroups('벽에 숫자 3이라고 적혀 있어요.')).toContain('READING');
    expect(wordingGroups('아이가 블록을 쌓아요.')).toEqual([]);
  });
});

describe('글 판정 (textVerdict) 은 서버의 다듬기와 같다', () => {
  it.each(SAMPLES.map((t) => [t]))('%s', (text) => {
    const kept = normaliseObservation({ summary: text, peopleCount: 1, childStates: ['CALM'] }, [0])!.summary !== null;
    expect(textVerdict(text) === 'kept').toBe(kept);
  });

  it('빠진 까닭을 가른다', () => {
    expect(textVerdict('아이가 블록을 쌓는다.')).toBe('not_haeyo');
    expect(textVerdict('The child is stacking blocks.')).toBe('not_korean');
    expect(textVerdict('   ')).toBe('empty');
    expect(textVerdict('가'.repeat(2001))).toBe('too_long');
    expect(textVerdict('엄마가 블록을 쌓아요.')).toBe('wording:PERSON');
    expect(textVerdict('아이가 블록을 쌓아요.')).toBe('kept');
  });
});

describe('모델 출력 가르기 (analyseOutput)', () => {
  it('JSON 이 아니면 not_json', () => {
    expect(analyseOutput('{"summary": "아이가', [0], TAGS).result).toBe('not_json');
  });

  it('사람 수가 없으면 no_people_count', () => {
    expect(analyseOutput('{"summary":"아이가 놀아요."}', [0], TAGS).result).toBe('no_people_count');
  });

  it('남는 것이 없으면 nothing_left, 걸린 갈래를 센다', () => {
    const text = JSON.stringify({
      summary: '화면에 3이라고 적혀 있어요.',
      childStates: [],
      adultResponses: [],
      moments: [{ t: 0, note: '벽에 글자가 쓰여 있어요.' }],
      peopleCount: 1,
    });
    const a = analyseOutput(text, [0], TAGS);
    expect(a.result).toBe('nothing_left');
    expect(a.verdicts).toEqual(['wording:READING', 'wording:READING']);
    expect(a.groupHits).toEqual({ READING: 2 });
  });

  it('목록에 없는 태그를 센다', () => {
    const text = JSON.stringify({ summary: '아이가 놀아요.', childStates: ['CALM', 'SLEEPY'], adultResponses: [1], moments: [], peopleCount: 1 });
    const a = analyseOutput(text, [0], TAGS);
    expect(a.result).toBe('ok');
    expect(a.invalidTags).toBe(2);
  });
});

describe('장면 요약 (summariseScene)', () => {
  const attempt = (result: string, verdicts: string[], ms = 1000) => ({
    ms, result, doneReason: 'stop', promptTokens: 1800, outputTokens: 200, verdicts,
    groupHits: verdicts.filter((v) => v.startsWith('wording:')).reduce<Record<string, number>>((m, v) => {
      const g = v.slice(8);
      m[g] = (m[g] ?? 0) + 1;
      return m;
    }, {}),
    summaryKept: result === 'ok' && verdicts[0] === 'kept', peopleCount: 1,
  });
  const runs: RunRecord[] = [
    { scene: 's', outcome: 'ok', ms: 10_000, attempts: [attempt('ok', ['kept', 'kept'])] },
    { scene: 's', outcome: 'ok', ms: 30_000, attempts: [attempt('nothing_left', ['wording:READING']), attempt('ok', ['wording:GUESS', 'kept'])] },
    { scene: 's', outcome: 'bad_output', ms: 20_000, attempts: [attempt('not_json', []), attempt('nothing_left', ['not_haeyo'])] },
  ];

  it('비율·재시도·빠진 까닭을 센다', () => {
    const s = summariseScene('s', runs);
    expect(s).toMatchObject({ runs: 3, ok: 2, badOutput: 1, retried: 2, rescued: 1, msMedian: 20_000, msMax: 30_000, texts: 6, dropped: 3 });
    expect(s.dropReasons).toEqual({ 'wording:READING': 1, 'wording:GUESS': 1, not_haeyo: 1 });
    expect(s.attemptResults).toEqual({ ok: 2, nothing_left: 2, not_json: 1 });
    expect(s.summaryDropped).toBe(1);
    expect(s.peopleCounts).toEqual({ '1': 2 });
  });

  it('CSV 줄에는 갈래 이름과 숫자만 있다', () => {
    const row = sceneCsvRow(summariseScene('s', runs));
    expect(row.startsWith('s,3,2,1,0,0,2,1,20000,30000,6,3,')).toBe(true);
    expect(row).not.toMatch(/[가-힣]/);
  });
});

describe('percentile', () => {
  it('중앙값과 끝값', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });
});
