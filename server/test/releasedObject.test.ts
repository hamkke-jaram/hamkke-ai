import { describe, expect, it } from 'vitest';
import { releaseTime } from '../src/releasedObject.ts';
import { buildPrompt } from '../src/prompt.ts';
import { reviewedObservation } from '../src/visualReview.ts';
import type { Observation } from '../src/observation.ts';
import type { VisionProvider } from '../src/provider.ts';

const motion = { motion:'PROPELLED_THROUGH_AIR', heldImage:1, freeImage:2 };
const times = [1,1.6,2];
const distinct = ['held','in-flight','after'];
const child = { appearance:'CLEAR_CHILDREN_ONLY', participants:'ONE_VISIBLE_PARTICIPANT', activity:'NO_CLEAR_PLAY' };
const draft = (summary: string, fields: Partial<Observation> = {}): Observation => ({
  summary, moments:[], childStates:[], adultResponses:[], peopleCount:1, ...fields,
});

async function review(before: Observation, result: object, images = distinct) {
  let first = true;
  const model: VisionProvider = {
    modelVersion:'test', isReady:async () => true,
    generate:async () => {
      if (!first) return JSON.stringify({ ...child, ...result });
      first = false;
      return JSON.stringify(before);
    },
  };
  return (await reviewedObservation(model, { ...buildPrompt(times,2), signal:new AbortController().signal, images },times)).observation;
}

it.each([
  ['동일 사진', times, ['one','one','later'], motion],
  ['동일 시각', [1,1,2], distinct, motion],
  ['순서 오류', times, distinct, { ...motion, heldImage:2, freeImage:1 }],
  ['화면 범위 밖', times, distinct, { ...motion, freeImage:4 }],
  ['긴 시간 간격', [1,9,17], distinct, motion],
  ['손에 쥔 채', times, distinct, { ...motion, motion:'OTHER' }],
] as const)('%s인 경우 던짐 시점을 만들지 않는다', (_description, t, images, result) => {
  expect(releaseTime(JSON.stringify(result),t,images)).toBeNull();
});

describe('무음 장면의 던짐과 큰 소리 구분', () => {
  it('별도 검토가 물체의 이탈을 확인하면 해당 시각에 행동을 추가한다', async () => {
    const got = await review(draft('아이가 공을 손에 들고 있어요.'),motion);
    expect(got?.moments).toContainEqual({t:1.6,note:'손에 들고 있던 물체를 던져요.'});
    expect(got?.summary).toContain('아이가 공을 손에 들고 있어요.');
    expect(got?.childStates).not.toContain('THROWING_OR_HITTING');
  });

  it('연령이 불확실하면 확인한 던짐에 아이 태그나 대상을 붙이지 않는다', async () => {
    const got = await review(draft('한 사람이 공을 던져요.',{childStates:['THROWING_OR_HITTING']}),{...motion,appearance:'UNRESOLVED'});
    expect(got?.summary).toBe('손에 들고 있던 물체를 던져요.');
    expect(got?.childStates).not.toContain('THROWING_OR_HITTING');
  });

  it('같은 사진의 재전송으로 던짐을 확정하거나 다른 동작까지 지우지 않는다', async () => {
    const got = await review(draft('아이가 팔을 흔들며 공을 던져요.',{childStates:['MOVING_AROUND','THROWING_OR_HITTING']}),motion,['one','one','one']);
    expect(got?.summary).toBe('아이가 팔을 흔들어요.');
    expect(got?.childStates).toEqual([]);
  });

  it('입을 벌린 모습은 보존하고 소리와 울음 태그는 보류한다', async () => {
    const got = await review(draft('아이가 입을 벌리고 큰 소리로 비명을 질러요.', {childStates:['UPSET_CRYING']}), {});
    expect(got?.summary).toBe('아이가 입을 벌리고 있어요.');
    expect(got?.childStates).toEqual([]);
  });

  it('다른 사람을 겨냥했다는 원래 추측은 확인된 동작에 덧붙이지 않는다', async () => {
    const got = await review(draft('아이가 창문을 겨냥하고 공을 던져요.'),motion);
    expect(got?.summary).toBe('손에 들고 있던 물체를 던져요.');
  });

  it.each(['받아주는 놀이를 해요.', '받아내는 놀이를 해요.'])('한 사람의 던짐에서 %s라는 추정을 뺀다', async sentence => {
    const got = await review(draft('아이가 공을 던져요. ' + sentence), motion);
    expect(got?.summary).toBe('손에 들고 있던 물체를 던져요.');
  });
});
