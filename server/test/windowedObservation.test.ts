import { expect, it } from 'vitest';
import type { Observation } from '../src/observation.ts';
import { mergeWindowObservations } from '../src/windowedObservation.ts';

it('일찍 보인 울음과 후반의 독립적인 행동을 같은 기록에 남긴다', () => {
  const windows: Observation[] = [
    { summary:'아이가 울고 있어요.', childStates:['UPSET_CRYING'], adultResponses:[], peopleCount:2, moments:[
      { t:2, note:'어른이 벽 앞에 서 있어요.' }, { t:5.7, note:'아이가 울고 있어요.' },
    ] },
    { summary:null, childStates:['PLAYING_ALONE'], adultResponses:[], peopleCount:1, moments:[
      { t:13, note:'아이가 블록을 쌓아요.' }, { t:15, note:'아이가 블록을 내려놓아요.' },
    ] },
    { summary:null, childStates:[], adultResponses:[], peopleCount:0, moments:[] },
    { summary:null, childStates:['FOCUSED'], adultResponses:[], peopleCount:1, moments:[
      { t:33, note:'아이가 책장을 넘겨요.' },
    ] },
  ];

  const result = mergeWindowObservations(windows);
  expect(result.moments.map(moment => moment.t)).toEqual([5.7,13,15,33]);
  expect(result.summary).toContain('아이가 울고 있어요.');
  expect(result.peopleCount).toBe(2);
  expect(result.childStates).toEqual(['UPSET_CRYING','PLAYING_ALONE','FOCUSED']);
});

it('울음 문장이 없는 태그와 반복 장면을 요약에서 제거한다', () => {
  const note = '아이가 물건을 만져요.';
  const window = (t: number): Observation => ({ summary:note, peopleCount:1,
    childStates:['UPSET_CRYING'], adultResponses:[], moments:[{t,note}] });
  const result = mergeWindowObservations([window(2),window(15)]);
  expect(result.moments).toEqual([{t:2,note}]);
  expect(result.summary).toBe(note);
  expect(result.childStates).toEqual([]);
});
