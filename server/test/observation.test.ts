import { describe, expect, it } from 'vitest';
import {
  MAX_MOMENTS,
  MAX_NOTE_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TAGS,
  endsInHaeyo,
  limitText,
  normaliseObservation,
  parseModelJson,
  snapToFrameTime,
} from '../src/observation.ts';
import { EVALUATIVE_TERMS } from '../src/wording.ts';
import { GOOD_OUTPUT } from './helpers.ts';

const TIMES = [0, 10, 20, 30];

function normalise(overrides: Record<string, unknown> = {}) {
  return normaliseObservation({ ...GOOD_OUTPUT, ...overrides }, TIMES);
}

describe('parseModelJson', () => {
  it('JSON 그대로를 읽는다', () => {
    expect(parseModelJson(' {"a":1} ')).toEqual({ a: 1 });
  });
  it('앞뒤에 붙은 글은 건너뛰고 가장 바깥 중괄호만 읽는다', () => {
    expect(parseModelJson('결과예요:\n```json\n{"a":{"b":2}}\n```')).toEqual({ a: { b: 2 } });
  });
  it('JSON 이 없으면 undefined', () => {
    expect(parseModelJson('아무것도 없어요')).toBeUndefined();
    expect(parseModelJson('{ 깨진')).toBeUndefined();
  });
});

describe('normaliseObservation', () => {
  it('쓸 수 있는 출력은 그대로 남긴다', () => {
    const obs = normalise();
    expect(obs).not.toBeNull();
    expect(obs!.summary).toBe(GOOD_OUTPUT.summary);
    expect(obs!.childStates).toEqual(['PLAYING_TOGETHER', 'REFUSING']);
    expect(obs!.adultResponses).toEqual(['WAITING', 'TALKING']);
    expect(obs!.moments).toEqual([{ t: 10, note: '아이가 블록을 밀어내요.' }]);
    expect(obs!.peopleCount).toBe(2);
  });

  it('객체가 아니거나 사람 수가 없으면 null', () => {
    expect(normaliseObservation('글', TIMES)).toBeNull();
    expect(normaliseObservation([GOOD_OUTPUT], TIMES)).toBeNull();
    expect(normalise({ peopleCount: undefined })).toBeNull();
    expect(normalise({ peopleCount: Number.NaN })).toBeNull();
  });

  it('사람 수는 0~3 정수로 맞춘다', () => {
    expect(normalise({ peopleCount: 7 })!.peopleCount).toBe(3);
    expect(normalise({ peopleCount: 1.6 })!.peopleCount).toBe(2);
  });

  it('사람이 없으면 태그와 순간 메모를 비운다', () => {
    const obs = normalise({ peopleCount: 0, summary: '방에 블록과 공이 놓여 있어요.' });
    expect(obs).toEqual({
      summary: '방에 블록과 공이 놓여 있어요.',
      childStates: [],
      adultResponses: [],
      moments: [],
      peopleCount: 0,
    });
  });

  it('목록에 없는 태그와 겹친 태그는 빼고 3개까지만 둔다', () => {
    const obs = normalise({
      childStates: ['CALM', 'UNKNOWN', 'CALM', 'FOCUSED', 'SEEKING_ADULT', 'PLAYING_ALONE', 7],
      adultResponses: 'TALKING',
    });
    expect(obs!.childStates).toEqual(['CALM', 'FOCUSED', 'SEEKING_ADULT']);
    expect(obs!.childStates.length).toBeLessThanOrEqual(MAX_TAGS);
    expect(obs!.adultResponses).toEqual([]);
  });

  it('검사 뒤에 남은 것이 하나도 없으면 null', () => {
    expect(normalise({ summary: null, childStates: [], adultResponses: [], moments: [] })).toBeNull();
  });
});

describe('요약 글 검사', () => {
  it('평가하는 낱말이 있으면 요약을 통째로 버린다', () => {
    for (const term of EVALUATIVE_TERMS) {
      expect(normalise({ summary: `아이가 블록을 쌓아요. ${term} 같은 모습이에요.` })!.summary).toBeNull();
    }
  });

  it('조언하거나 까닭을 짐작하는 말투는 버린다', () => {
    expect(normalise({ summary: '아이가 울어요. 아이를 안아 주세요.' })!.summary).toBeNull();
    expect(normalise({ summary: '아이가 졸려서 우는 것 같아요.' })!.summary).toBeNull();
  });

  it('한글이 없거나 한자·가나가 섞이면 버린다', () => {
    expect(normalise({ summary: 'The child is playing.' })!.summary).toBeNull();
    expect(normalise({ summary: '아이가 積木를 쌓아요.' })!.summary).toBeNull();
  });

  it('해요체가 아닌 문장은 그 문장만 뺀다', () => {
    expect(normalise({ summary: '아이가 블록을 쌓는다. 어른이 옆에서 기다려요.' })!.summary).toBe('어른이 옆에서 기다려요.');
  });

  it('공백 없이 붙여 쓴 문장도 나눈다(소수점은 나누지 않는다)', () => {
    expect(normalise({ summary: '아이가 논다.어른이 1.5초 기다려요.' })!.summary).toBe('어른이 1.5초 기다려요.');
  });

  it('줄바꿈·제어 문자를 공백으로 바꾸고, 짝 없는 대리 문자는 지운다', () => {
    const obs = normalise({ summary: `아이가\n블록을\t쌓아요.\uD800 어른이 웃어요.` });
    expect(obs!.summary).toBe('아이가 블록을 쌓아요. 어른이 웃어요.');
    expect(obs!.summary).not.toMatch(/\p{Cs}/u);
  });

  it('지나치게 긴 글은 받지 않는다', () => {
    expect(normalise({ summary: '아이가 웃어요. '.repeat(400) })!.summary).toBeNull();
  });
});

describe('순간 메모', () => {
  it('보낸 사진 시각으로 맞추고, 시각 순으로 4개까지만 둔다', () => {
    const notes = ['아이가 공을 굴려요.', '어른이 공을 받아요.', '아이가 웃어요.', '어른이 손뼉을 쳐요.', '아이가 앉아요.'];
    const obs = normalise({ moments: notes.map((note, i) => ({ t: 31 - i * 7, note })) });
    expect(obs!.moments).toHaveLength(MAX_MOMENTS);
    expect(obs!.moments.map((m) => m.t)).toEqual([10, 20, 20, 30]);
    for (const m of obs!.moments) expect(TIMES).toContain(m.t);
  });

  it('시각이 숫자가 아니거나 글이 검사에 걸린 항목, 같은 말은 뺀다', () => {
    const obs = normalise({
      moments: [
        { t: '10', note: '아이가 웃어요.' },
        { t: 10, note: '아이를 안아 주세요.' },
        { t: 20, note: '아이가 웃어요.' },
        { t: 30, note: '아이가 웃어요.' },
        null,
      ],
    });
    expect(obs!.moments).toEqual([{ t: 20, note: '아이가 웃어요.' }]);
  });

  it('메모는 120자를 넘지 않는다', () => {
    const long = `아이가 ${'블록을 하나씩 '.repeat(30)}쌓아요.`;
    const obs = normalise({ moments: [{ t: 0, note: long }] });
    expect(obs!.moments[0]!.note.length).toBeLessThanOrEqual(MAX_NOTE_LENGTH);
    expect(obs!.moments[0]!.note.endsWith('…')).toBe(true);
  });
});

describe('도우미', () => {
  it('endsInHaeyo', () => {
    expect(endsInHaeyo('아이가 웃어요.')).toBe(true);
    expect(endsInHaeyo('아이가 웃어요!"')).toBe(true);
    expect(endsInHaeyo('아이가 웃는다.')).toBe(false);
  });

  it('limitText 는 문장 수와 길이를 맞춘다', () => {
    expect(limitText('하나예요. 둘이에요. 셋이에요. 넷이에요.', 3, MAX_SUMMARY_LENGTH)).toBe('하나예요. 둘이에요. 셋이에요.');
    expect(limitText('하나예요. 둘이에요.', 3, 8)).toBe('하나예요.');
    const cut = limitText('가'.repeat(20), 1, 10);
    expect(cut).toHaveLength(10);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('limitText 는 자를 때 반쪽 글자를 남기지 않는다', () => {
    const cut = limitText(`${'가'.repeat(8)}😀😀`, 1, 10);
    expect(cut).not.toMatch(/\p{Cs}/u);
  });

  it('snapToFrameTime 은 가장 가까운 사진 시각을 고른다', () => {
    expect(snapToFrameTime(14, TIMES)).toBe(10);
    expect(snapToFrameTime(16, TIMES)).toBe(20);
    expect(snapToFrameTime(-5, TIMES)).toBe(0);
    expect(snapToFrameTime(99, TIMES)).toBe(30);
  });
});
